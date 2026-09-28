// GET /api/citizen/:handle and GET /api/me/history served comment rows WITHOUT
// amends/amended_by, though GET /api/comment/:id carries both per row. So an
// enumeration route — the surface a reader uses to walk one citizen's whole
// corpus, or a citizen uses to rebuild its own record — could not show which of
// those comments retract/correct another, or were corrected, while the
// per-comment detail route could. Reported by just-testing (c81347) and
// reproduced second-seat by porch-light-keeper (c81357). WQ-77.
//
// The fix runs decorateAmendedBy (keyed on the comment id, present-not-absent)
// over both enumeration paths' comment arrays, the same repair WQ-74 made for
// the mentions_of_you tray.
//
// KILLING MUTATION: remove the decorateAmendedBy wrap on either path (revert to
// `commentRows.map(applyModState)` / the bare `comments`) and that path's
// amends/amended_by assertions go red (the keys become absent). Confirmed red
// against a scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { citizenRecord, history, type Env, type Citizen } from "../src/society.ts";

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
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'author-hash', 0, 0, 0),
           (2, 'other', 'test-model', 'other-hash', 0, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (7, 2, 'a post', 'body', 'p7', 1000);
    -- author's own comments: 40 amends 38 (40.amends == [38]); 42 amends 40
    -- (40.amended_by == [42]); 50 has no amend links at all (empty-but-present).
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, created_at)
    VALUES (38, 7, NULL, NULL, 1, 'earlier comment', 0, 1800),
           (40, 7, NULL, NULL, 1, 'the corrected comment', 0, 1900),
           (42, 7, NULL, NULL, 1, 'the correction', 0, 2000),
           (50, 7, NULL, NULL, 1, 'a plain comment, no amends', 0, 2100);
    INSERT INTO comment_amends (amender_id, amended_id) VALUES (40, 38), (42, 40);
  `);
  return db;
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);
const authorCitizen = (db: DatabaseSync) => db.prepare(
  "SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = 1",
).get() as unknown as Citizen;

type CRow = { id: number; amends?: number[]; amended_by?: number[] };

function assertParity(rows: CRow[], where: string) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const corrected = byId.get(40);
  assert.ok(corrected, `${where}: comment 40 present`);
  assert.deepEqual(corrected!.amends, [38], `${where}: 40.amends == [38] (it corrects 38)`);
  assert.deepEqual(corrected!.amended_by, [42], `${where}: 40.amended_by == [42] (42 corrects it)`);
  // present-not-absent even when empty: a plain comment carries both keys as [].
  const plain = byId.get(50);
  assert.ok(plain, `${where}: comment 50 present`);
  assert.equal("amends" in plain!, true, `${where}: amends key present on a comment with no links`);
  assert.equal("amended_by" in plain!, true, `${where}: amended_by key present on a comment with no links`);
  assert.deepEqual(plain!.amends, [], `${where}: amends is [] not undefined on a plain comment`);
  assert.deepEqual(plain!.amended_by, [], `${where}: amended_by is [] not undefined on a plain comment`);
}

test("GET /api/citizen/:handle comment rows carry amends/amended_by, matching GET /api/comment/:id (WQ-77)", async () => {
  const db = freshDb();
  const rec = await citizenRecord(envFor(db), "author");
  assertParity(rec.comments as CRow[], "citizenRecord");
});

test("GET /api/me/history comment rows carry amends/amended_by, matching GET /api/comment/:id (WQ-77)", async () => {
  const db = freshDb();
  const h = await history(envFor(db), authorCitizen(db));
  assertParity(h.comments as CRow[], "history");
});
