// WQ-49 (witnessmark #6129, c71437): the amends link rides on GET /api/comment/:id,
// the thread read and /api/me, but /api/changes — the cheapest way to poll the
// board — carried neither amended_by on its comment rows nor the amends_note
// disclosure. A checker polling the firehose therefore could not tell "this
// comment was never amended" from "this feed does not project the link",
// exactly the not-projected-vs-absent ambiguity the amends family closes
// everywhere else.
//
// What this file guards: a /api/changes comment row carries amended_by (the
// ids, ascending, of same-author comments that amend it) and the response
// carries amends_note. Delete `decoratedComments`/revert `comments:` to the
// undecorated slice and the amended_by assertion goes red; delete the
// `amends_note: AMENDS_NOTE` line and the disclosure assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...(this.args as never[])).changes) } }; }
}

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  // Two comments by the SAME author on the SAME post: 22 amends 21. 23 is an
  // unamended control by the same author.
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (11, 1, 'a post', 'body', NULL, 'p11', NULL, 200, NULL);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, amends)
    VALUES (21, 11, NULL, 1, 'the original', 0, NULL, 210, NULL),
           (22, 11, NULL, 1, 'the correction', 0, NULL, 220, 21),
           (23, 11, NULL, 1, 'an unamended comment', 0, NULL, 230, NULL);
  `);
  return { DB: { prepare: (sql: string) => new Statement(sqlite, sql) } } as unknown as Env;
}

async function withNow<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => 300;
  try { return await fn(); } finally { Date.now = realNow; }
}

test("a /api/changes comment row carries amended_by, listing the same-author comment that amends it", async () => {
  const page = await withNow(() => changes(seed(), 170));
  const byId = new Map(page.comments.map((c) => [c.id, c]));
  const original = byId.get(21);
  const correction = byId.get(22);
  const control = byId.get(23);
  assert.ok(original && correction && control, "all three comments must be on the page");

  assert.ok("amended_by" in original!, "the original comment row must carry an amended_by key");
  assert.deepEqual(original!.amended_by, [22], "amended_by on the original names the comment that amends it");
  assert.deepEqual(correction!.amended_by, [], "the amending comment itself has an empty amended_by");
  assert.deepEqual(control!.amended_by, [], "an unamended comment carries an empty amended_by, not a missing key");
});

test("the /api/changes response carries the amends_note disclosure", async () => {
  const page = await withNow(() => changes(seed(), 170));
  assert.equal(typeof page.amends_note, "string");
  assert.match(page.amends_note, /amended_by/, "the note explains what amended_by means");
  assert.match(page.amends_note, /never populated retroactively|not.*retroactive/i, "the note discloses the field is not backfilled");
});
