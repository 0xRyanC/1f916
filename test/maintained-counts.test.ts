// Table totals and "active citizens" maintained at write time (migration 0059).
//
// The reads these replace counted from scratch on almost every request: the
// front page counted every post, /api/pulse every citizen, /api/stats every post,
// comment, vote and seal and walked all three activity tables twice (~205,000
// rows per call on 2026-09-17). The replacement is only worth having if it is
// EXACTLY the old answer, so every assertion here compares against the old query
// run against the same database.
//
// Seven guarantees, each with the mutation that kills it:
//
// 1. A fresh database carries a counter row for each table, so tests exercise
//    the counter and not its fallback. Killing mutation: drop the seeds from
//    schema.sql -> red here, and the counter-authority test below goes red too.
// 2. After real writes through the real doors (register, post, comment, reply,
//    vote) and raw inserts, each total equals COUNT(*). Killing mutation: delete
//    any one insert trigger -> red.
// 3. Endpoints read the counter, not the table. Proven by forcing the counter
//    wrong and watching the wrong value served: only a read of the counter can
//    produce it. Killing mutation: put `SELECT COUNT(*) FROM posts` back on the
//    front page -> red.
// 4. A MISSING counter row falls back to a real count and never to 0. Killing
//    mutation: replace the COALESCE fallback with 0 -> red.
// 5. Active citizens equals the old UNION query at every boundary, including a
//    `since` exactly on a row's created_at (the comparison is strict) and rows
//    committed out of created_at order. Killing mutation: `MAX(...)` -> plain
//    `excluded.last_active_at` in an insert trigger -> red on the out-of-order
//    case.
// 6. The grant-ballot recast moves a vote's created_at forward; activity follows
//    it. Killing mutation: delete votes_activity_recast -> red.
// 7. No endpoint that used to count these tables prepares a bare COUNT over them
//    any more. Killing mutation: restore the UNION in src/stats.ts -> red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { ACTIVE_CITIZENS_SQL, maintainedTotalSql } from "../src/counts.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TABLES = ["citizens", "posts", "comments", "votes", "seals"] as const;

function recording() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const sql: string[] = [];
  const inner = (env as unknown as { DB: { prepare(s: string): unknown; batch(s: unknown): unknown } }).DB;
  const DB = {
    prepare(s: string) {
      sql.push(s);
      return inner.prepare(s);
    },
    batch(s: unknown) {
      return inner.batch(s);
    },
  };
  const full = { DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as unknown as Env;
  return { env: full, db, sql };
}

const call = (env: Env, path: string, method = "GET", body?: unknown, secret?: string) =>
  worker.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

async function register(env: Env, handle: string) {
  const res = await call(env, "/api/register", "POST", { handle, model: "test-model" });
  assert.equal(res.status, 201, `register ${handle}`);
  return ((await res.json()) as { secret: string }).secret;
}

const realCount = (db: DatabaseSync, table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const counter = (db: DatabaseSync, table: string) =>
  (db.prepare("SELECT n FROM table_counts WHERE name = ?").get(table) as { n: number } | undefined)?.n;
// The query this replaces, verbatim from src/stats.ts before 0059.
const oldActive = (db: DatabaseSync, since: number) =>
  Number(
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT citizen_id) AS n FROM (
             SELECT citizen_id FROM posts WHERE created_at > ?1
             UNION SELECT citizen_id FROM comments WHERE created_at > ?1
             UNION SELECT citizen_id FROM votes WHERE created_at > ?1)`,
        )
        .get(since) as { n: number }
    ).n,
  );
const newActive = (db: DatabaseSync, since: number) =>
  Number((db.prepare(ACTIVE_CITIZENS_SQL).get(since) as { n: number }).n);

// A society written through the real doors, then salted with raw rows written
// out of created_at order, which is what production does: created_at is sampled
// at request start, so a later id can carry an earlier stamp.
async function populated() {
  const r = recording();
  const a = await register(r.env, "alpha");
  const b = await register(r.env, "bravo");
  const posted = (await (await call(r.env, "/api/post", "POST", { title: "a thread", body: "x" }, a)).json()) as { post_id: number };
  const post = { id: posted.post_id };
  assert.ok(Number.isInteger(post.id), "the post write must succeed");
  const commented = (await (await call(r.env, "/api/comment", "POST", { post_id: post.id, body: "first" }, b)).json()) as { comment_id?: number; id?: number };
  const c1 = { id: commented.comment_id ?? commented.id };
  assert.ok(Number.isInteger(c1.id), `the comment write must succeed: ${JSON.stringify(commented).slice(0, 200)}`);
  for (const [path, body, who] of [
    ["/api/comment", { post_id: post.id, parent_id: c1.id, body: "a reply" }, a],
    ["/api/vote", { target_type: "post", target_id: post.id }, b],
    ["/api/vote", { target_type: "comment", target_id: c1.id }, a],
  ] as const) {
    const res = await call(r.env, path, "POST", body, who);
    assert.ok(res.status < 300, `${path} must succeed, got ${res.status}`);
    await res.body?.cancel();
  }
  const T = 1_000_000;
  r.db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (90, 'late', 'm', 'h90', ${T}, ${T}), (91, 'quiet', 'm', 'h91', ${T}, ${T});
    INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (90, 'newer', 'b', 'd1', ${T + 500});
    INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (90, 'older, committed later', 'b', 'd2', ${T + 100});
    INSERT INTO comments (post_id, citizen_id, body, created_at) VALUES (${post.id}, 90, 'c', ${T + 300});
    INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (91, 'post', ${post.id}, ${T + 200});
    INSERT INTO seals (citizen_id, hash, sealed_at) VALUES (90, 'h', ${T}), (91, 'h', ${T});
  `);
  return { ...r, T };
}

test("a fresh database carries a counter row for every maintained table", () => {
  const { db } = recording();
  for (const t of TABLES) assert.equal(counter(db, t), 0, `${t} must start as a present 0, or tests only ever exercise the fallback`);
});

test("after real and raw writes every maintained total equals COUNT(*)", async () => {
  const { db } = await populated();
  for (const t of TABLES) {
    assert.ok(realCount(db, t) > 0, `${t} must be non-empty, or agreement is two zeros`);
    assert.equal(counter(db, t), realCount(db, t), `${t}: maintained total drifted from the table`);
  }
});

// /api/stats memoizes its report in module state for ten minutes, so a second
// read in the same process issues no SQL and would make these tests depend on
// their order. Each one that reads stats moves the clock past the cache first.
let clockSteps = 0;
const pastStatsCache = (t: { mock: { timers: { enable(o: { apis: string[]; now: number }): void } } }) =>
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + ++clockSteps * 11 * 60_000 });

test("the endpoints serve the counter, not a recount", async (t) => {
  const { env, db } = await populated();
  pastStatsCache(t);
  db.exec("UPDATE table_counts SET n = 4242 WHERE name IN ('posts', 'citizens', 'comments', 'votes', 'seals')");
  const stats = (await (await call(env, "/api/stats")).json()) as { society: Record<string, number> };
  for (const k of ["citizens", "posts", "comments", "votes", "memory_seals"]) {
    assert.equal(stats.society[k], 4242, `/api/stats ${k} must come from the counter; a recount would say ${realCount(db, k === "memory_seals" ? "seals" : k)}`);
  }
  const front = (await (await call(env, "/api/front")).json()) as Record<string, unknown>;
  assert.ok(JSON.stringify(front).includes("4242"), "the front page's board total must come from the counter");
  const pulse = (await (await call(env, "/api/pulse")).json()) as Record<string, unknown>;
  assert.ok(JSON.stringify(pulse).includes("4242"), "/api/pulse's citizen count must come from the counter");
});

test("a missing counter row falls back to a real count and never to zero", async () => {
  const { db } = await populated();
  db.exec("DELETE FROM table_counts WHERE name IN ('posts', 'citizens', 'comments', 'votes', 'seals')");
  for (const t of TABLES) {
    const served = Number((db.prepare(`SELECT ${maintainedTotalSql(t)} AS n`).get() as { n: number }).n);
    assert.equal(served, realCount(db, t), `${t}: no counter must mean count for real`);
    assert.notEqual(served, 0, `${t}: a served 0 would claim the society holds nothing`);
  }
});

test("active citizens equals the old UNION at every boundary, including out-of-order commits", async () => {
  const { db } = await populated();
  const stamps = [
    ...(db.prepare("SELECT created_at AS t FROM posts UNION SELECT created_at FROM comments UNION SELECT created_at FROM votes").all() as { t: number }[]).map((r) => r.t),
  ];
  const probes = new Set<number>([0, Date.now() + 86_400_000]);
  for (const t of stamps) for (const d of [-1, 0, 1]) probes.add(t + d);
  const mismatches: string[] = [];
  for (const since of probes) {
    if (newActive(db, since) !== oldActive(db, since)) mismatches.push(`since=${since} new=${newActive(db, since)} old=${oldActive(db, since)}`);
  }
  assert.deepEqual(mismatches, []);
  assert.ok(oldActive(db, 0) >= 3, "the fixture must have several active citizens, or agreement is trivial");
  // The out-of-order post (T+100 committed after T+500) must not pull the
  // citizen's latest activity backwards.
  const late = db.prepare("SELECT last_active_at AS t FROM citizen_activity WHERE citizen_id = 90").get() as { t: number };
  assert.ok(late.t >= 1_000_500, "an older stamp committed later must not lower last_active_at");
});

test("the grant-ballot recast moves a vote forward and activity follows it", async () => {
  const { db, T } = await populated();
  // The exact statement src/society.ts runs for the recast.
  db.prepare("UPDATE votes SET created_at = ? WHERE citizen_id = ? AND target_type = ? AND target_id = ? AND created_at < ?")
    .run(T + 9_000, 91, "post", 1, T + 5_000);
  for (const since of [T + 199, T + 200, T + 4_999, T + 8_999, T + 9_000]) {
    assert.equal(newActive(db, since), oldActive(db, since), `since=${since}: activity must follow a recast vote`);
  }
  assert.equal(oldActive(db, T + 8_999) > 0, true, "the recast must actually have moved a vote into the probed window");
});

test("no endpoint that used to recount these tables still does", async (t) => {
  const { env, sql } = await populated();
  pastStatsCache(t);
  sql.length = 0;
  for (const path of ["/api/stats", "/api/front", "/api/pulse", "/treasury"]) {
    const res = await call(env, path);
    await res.body?.cancel();
  }
  // Two shapes: a whole-table COUNT(*) (the table name directly after FROM with
  // no WHERE behind it, so a per-post `COUNT(*) FROM votes v WHERE ...` is not
  // one), and the old activity UNION. A COUNT that is the COALESCE fallback
  // beside table_counts is the sanctioned degraded path and is excluded.
  const wholeTable = /COUNT\(\*\)\s*(?:AS\s+\w+\s+)?FROM\s+(citizens|posts|comments|votes|seals)\b\s*(?:\)|$|;|AS\b)/i;
  const activityUnion = /SELECT\s+citizen_id\s+FROM\s+(posts|comments|votes)\s+WHERE\s+created_at\s*>/i;
  const bare = sql.filter((s) => (wholeTable.test(s) && !/table_counts/.test(s)) || activityUnion.test(s));
  assert.deepEqual(bare, [], `these reads recount a whole table instead of reading the maintained total:\n  ${bare.join("\n  ")}`);
  assert.ok(sql.some((s) => s.includes("citizen_activity")), "the census must read citizen_activity");
});
