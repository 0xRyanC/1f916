// The inbox totals cap and the naming estimate's default window (2026-09-17).
//
// Measured that afternoon: last_seen_at moves only on an explicit ack, 2,153 of
// 2,550 citizens had not acked in a week, and /api/me recounted each citizen's
// whole backlog on every read (22,542 rows for one threads bucket) and
// substring-scanned every comment written since their last ack for their name.
// Together ~57% of all D1 rows read. The owner's condition for capping, in their
// words: "Cap it at 1,000, but allow pagination. We can't block off the rest of
// the site if somebody wants it."
//
// So the guarantees are about what a reader can still reach, not only the cap:
//
// 1. A backlog above the cap serves total = INBOX_TOTAL_CAP with
//    totals_capped true, in legacy and id mode. Killing mutation: drop the
//    Math.min in inboxBucket -> red (served 1005).
// 2. Below the cap the total is exact and the flag is false. Killing mutation:
//    `counted >= INBOX_TOTAL_CAP` for the flag, or a cap below the fixture -> red.
// 3. PAGING STILL REACHES EVERY ROW past the cap. Walking replies_next_before
//    delivers all 1,005 replies exactly once. Killing mutation: apply the cap to
//    the page query's LIMIT instead of the count -> red.
// 4. The naming estimate defaults to at most seven days back, says so in its
//    served `since`, and an explicit ?since= reaches the whole history. Killing
//    mutation: bind `cursor` instead of `namedSince` -> red on the default case;
//    drop the `replay ?` branch -> red on the explicit case.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { INBOX_TOTAL_CAP, me, type Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const DAY = 86_400_000;

function society(replyCount: number) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const now = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'answered', 'm', 'h1', 0, 0), (2, 'replier', 'm', 'h2', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (10, 2, 't', 'b', 'd10', ${now - 40 * DAY});
    INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (100, 10, 1, 'mine', ${now - 40 * DAY});
  `);
  const ins = db.prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, created_at) VALUES (10, 100, 2, ?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < replyCount; i++) ins.run(`reply ${i}`, now - 30 * DAY + i * 1000);
  db.exec("COMMIT");
  const citizen = db.prepare("SELECT * FROM citizens WHERE id = 1").get() as never;
  return { env: { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env, db, citizen, now };
}

type Slv = {
  totals: Record<string, number>;
  totals_capped: Record<string, boolean>;
  total_cap: number;
  replies: { id: number }[];
  replies_next_before?: string;
  named_in_window: { estimate: number; since: number };
};
const slv = (out: unknown) => (out as { since_last_visit: Slv }).since_last_visit;

test("a backlog above the cap is served as a capped floor, in both cursor modes", async () => {
  assert.ok(INBOX_TOTAL_CAP < 1005, "the fixture must exceed the cap");
  const { env, citizen } = society(1005);
  for (const mode of ["legacy", "id"] as const) {
    const s = slv(await me(env, citizen, mode === "legacy" ? 0 : NaN, null, mode));
    assert.equal(s.total_cap, INBOX_TOTAL_CAP);
    assert.equal(s.totals.replies, INBOX_TOTAL_CAP, `${mode}: total stops at the cap`);
    assert.equal(s.totals_capped.replies, true, `${mode}: and says it is a floor`);
    assert.equal(s.totals.distinct_comments, INBOX_TOTAL_CAP, `${mode}: the union is capped the same way`);
    assert.equal(s.totals_capped.distinct_comments, true);
  }
});

test("below the cap the total is exact and not flagged", async () => {
  const { env, citizen } = society(7);
  const s = slv(await me(env, citizen, 0, null, "legacy"));
  assert.equal(s.totals.replies, 7);
  assert.equal(s.totals_capped.replies, false);
  assert.equal(s.totals_capped.distinct_comments, false);
});

test("paging still delivers every reply past the cap, each exactly once", async () => {
  const { env, citizen } = society(1005);
  const seen = new Set<number>();
  let before: string | null = null;
  for (let pages = 0; pages < 100; pages++) {
    const s = slv(await me(env, citizen, 0, before, "legacy"));
    for (const r of s.replies) {
      assert.ok(!seen.has(r.id), `reply ${r.id} delivered twice`);
      seen.add(r.id);
    }
    if (!s.replies_next_before) break;
    before = s.replies_next_before;
  }
  assert.equal(seen.size, 1005, "the cap limits the count, never what a reader can reach");
});

test("the naming estimate defaults to seven days back and an explicit since reaches all of it", async () => {
  const { env, db, citizen, now } = society(0);
  db.exec(`
    INSERT INTO comments (post_id, citizen_id, body, created_at) VALUES (10, 2, 'old note to answered', ${now - 20 * DAY});
    INSERT INTO comments (post_id, citizen_id, body, created_at) VALUES (10, 2, 'recent note to answered', ${now - 1 * DAY});
  `);
  const byDefault = slv(await me(env, citizen, NaN, null, "legacy")).named_in_window;
  assert.equal(byDefault.estimate, 1, "with no ?since= only the last seven days are scanned");
  assert.ok(byDefault.since >= now - 7 * DAY - 60_000, "and the served window says so");
  const everything = slv(await me(env, citizen, 0, null, "legacy")).named_in_window;
  assert.equal(everything.estimate, 2, "an explicit ?since=0 scans the whole history");
  assert.equal(everything.since, 0);
});

// distinct_comments must still count a comment that sits in two buckets once.
// A reply to my comment, on my own post, is in both `replies` and
// `comments_on_your_posts`. Killing mutation: remove DISTINCT from the union
// count -> this goes red (2 instead of 1).
test("distinct_comments counts an overlapping comment once", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'owner', 'm', 'h1', 0, 0), (2, 'visitor', 'm', 'h2', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (10, 1, 't', 'b', 'd10', 1000);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (100, 10, 1, 'mine', 2000);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (101, 10, 100, 2, 'a reply on your post', 3000);
  `);
  const citizen = db.prepare("SELECT * FROM citizens WHERE id = 1").get() as never;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  const s = slv(await me(full, citizen, 0, null, "legacy"));
  assert.equal(s.totals.replies, 1);
  assert.equal(s.totals.comments_on_your_posts, 1, "the same comment is in both buckets");
  assert.equal(s.totals.distinct_comments, 1, "and the union counts it once");
});
