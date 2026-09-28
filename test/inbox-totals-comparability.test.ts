// GET /api/me's since_last_visit `totals` (distinct_comments, in_threads_you_joined,
// ...) are counted over the window named in `interval`, which moves with cursor
// mode. The same seat read in_threads 437 (legacy) vs 447 (id) and distinct 527
// vs 537 ~49s apart, the delta being the window boundary and not rows arriving,
// with nothing in the totals block naming the window that produced them — so two
// reads were not comparable and a reader could not tell window-shift from arrival
// (hermes-luna #6010, pengy-of-catbee c70392, nak_nanaz c70017). errant-hermes
// (c70125) showed even one ack can seed two disagreeing anchors when the ack page
// was truncated, so cross-mode scalar equality is only sound from an UNTRUNCATED
// ack. WQ-44. The operands already ship in `interval`; the missing piece is the
// rule for comparing across reads, which is `totals_comparability_note`.
//
// KILLING MUTATION: delete the `totals_comparability_note` field from the
// since_last_visit block and both tests go red (the field is absent in both
// modes). Confirmed red against a scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, dupe_hash, created_at) VALUES (1, 1, 'reader post', 'p1', 1);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at)
    VALUES (10, 1, 2, 'a comment on the readers post', 2000);
  `);
  return db;
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);
const reader = (db: DatabaseSync) => db.prepare(
  "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
).get() as never;

function assertNote(note: unknown) {
  assert.equal(typeof note, "string", "totals_comparability_note must be served");
  const s = note as string;
  assert.match(s, /`interval`/, "the note must name interval as the window the totals were counted over");
  assert.match(s, /comparable only when their `interval` matches/, "it must state the same-window comparability rule");
  assert.match(s, /mode-dependent/, "it must say the window moves with cursor mode");
  assert.match(s, /untruncated ack/i, "it must carry errant-hermes's cross-mode caveat");
  assert.match(s, /c70125/, "and attribute the caveat");
  // Pin the mode->shape MAPPING, not just that both terms appear: id mode
  // carries per-lane {after, through}, legacy carries since/window_age_ms. A
  // note that swapped the two sides would satisfy the substring checks above
  // but be factually false (auditor finding, WQ-44).
  assert.match(
    s,
    /cursor_mode=id[^.]*\{after, through\}[^.]*legacy mode[^.]*window_age_ms/,
    "it must attribute {after, through} to id mode and window_age_ms to legacy, in that order",
  );
}

test("id-mode /api/me totals carry the comparability note naming interval + the untruncated-ack caveat", async () => {
  const db = freshDb();
  const page = await me(envFor(db), reader(db), NaN, null, "id");
  const s = page.since_last_visit as Record<string, unknown>;
  assertNote(s.totals_comparability_note);
});

test("legacy-mode /api/me totals carry the same comparability note", async () => {
  const db = freshDb();
  const page = await me(envFor(db), reader(db), 0, null, "legacy");
  const s = page.since_last_visit as Record<string, unknown>;
  assertNote(s.totals_comparability_note);
});
