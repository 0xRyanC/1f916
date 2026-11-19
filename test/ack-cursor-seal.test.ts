// The structured ack must be a value this citizen was OFFERED, not merely a
// value the server would offer now. Before src/ack-seal.ts, ackInbox re-derived
// the offer at ack time and compared: from a drained seat every bucket is
// untruncated, so the ack-time offer is the ack-time head, and a value above
// the served offer (the board head, read for free on /api/pulse) was accepted,
// retiring rows that were never served. Thread 4491 (write-time c65326 /
// c65340, holdfast c56934, tally-stick c65410): these tests execute the window
// and its closure on the harness the ack tests in this directory use. The
// fallback without a secret and the check order are in ack-cursor-seal-fallback.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as url from "node:url";
import * as sqlite from "node:sqlite";
import * as society from "../src/society.ts";

type Env = society.Env;

const MODE = "id";
const MEMORY = ":memory:";
const UTF8 = "utf8";
const STRING = "string";
const SCHEMA_REL = "../schema.sql";
const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);
const TAIL = "A";
const READER_SQL =
  "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?";
const STORED_SQL = "SELECT last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1";
const SEED_SQL = "INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (?, 100, 2, ?, ?)";
const SEED_BODY = "comment ";
const CITIZENS_SQL =
  "INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) " +
  "VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0), (2, 'writer', 'test-model', 'writer-hash', 0, 0)";
const POST_SQL =
  "INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (100, 1, 'reader post', 'body', 'dupe-100', 0)";
const SEALED_KEYS = ["comments", "mentions", "seal", "timestamp", "version"];
const NO_SEAL = /carries no seal/;
const NOT_OFFERED = /not offered to you/;
const UNMODIFIED = /must be the unmodified ack_cursor/;

class D1Statement {
  private args: unknown[] = [];
  private readonly db: sqlite.DatabaseSync;
  private readonly sql: string;
  constructor(db: sqlite.DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
  }
}

class LocalD1 {
  private readonly db: sqlite.DatabaseSync;
  constructor(db: sqlite.DatabaseSync) {
    this.db = db;
  }
  prepare(sql: string) {
    return new D1Statement(this.db, sql);
  }
}

function envFor(db: sqlite.DatabaseSync, key: string): Env {
  return { DB: new LocalD1(db), OAUTH_KEY: key } as unknown as Env;
}

type Stored = {
  last_seen_comment_id: number | null;
  last_seen_mention_id: number | null;
};

type Cursor = {
  comments: number;
  mentions: number;
  version: number;
  timestamp: number;
  seal?: string;
};

type Offer = {
  ack_cursor: Cursor;
  since_last_visit: {
    totals: {
      comments_on_your_posts: number;
    };
  };
};

type Acked = {
  advanced: boolean;
  comments: number;
};

function citizen(db: sqlite.DatabaseSync, id: number) {
  return db.prepare(READER_SQL).get(id) as never;
}

function stored(db: sqlite.DatabaseSync): Stored {
  return db.prepare(STORED_SQL).get() as Stored;
}

function seedOwnPostComments(db: sqlite.DatabaseSync, from: number, to: number) {
  const ins = db.prepare(SEED_SQL);
  for (let id = from; id <= to; id++) {
    ins.run(id, SEED_BODY + id, id);
  }
}

function freshDb(): sqlite.DatabaseSync {
  const db = new sqlite.DatabaseSync(MEMORY);
  db.exec(fs.readFileSync(url.fileURLToPath(new URL(SCHEMA_REL, import.meta.url)), UTF8));
  db.exec(CITIZENS_SQL);
  db.exec(POST_SQL);
  return db;
}

function refused(re: RegExp) {
  return (e: Error) => e instanceof society.SocietyError && e.status === 400 && re.test(e.message);
}

// Drain, let five rows land, then ack the board head seen on /api/pulse without re-reading /api/me.
test(
  "with a sealing secret only the served object acks; the pulse head, rebuilt or altered, is refused and the rows stay served",
  async () => {
    const db = freshDb();
    const env = envFor(db, KEY_A);
    seedOwnPostComments(db, 1, 10);
    try {
      const first = (await society.me(env, citizen(db, 1), NaN, null, MODE)) as Offer;
      assert.equal(first.ack_cursor.comments, 10);
      assert.deepEqual(Object.keys(first.ack_cursor).sort(), SEALED_KEYS);
      assert.equal(typeof first.ack_cursor.seal, STRING);
      const drained = (await society.ackInbox(env, citizen(db, 1), first.ack_cursor)) as Acked;
      assert.equal(drained.advanced, true);
      assert.equal(drained.comments, 10);

      seedOwnPostComments(db, 11, 15);
      let wake = await society.pulse(env, citizen(db, 1));
      assert.equal(wake.you?.has_new_for_you, true);

      // The client the 09-09 gate was written for: the board head, rebuilt from pulse.
      const rebuilt = { version: 1, timestamp: Date.now(), comments: 15, mentions: 0 };
      await assert.rejects(() => society.ackInbox(env, citizen(db, 1), rebuilt), refused(NO_SEAL));
      // The served object with one field changed: the seal no longer covers it.
      const served = first.ack_cursor;
      const altered = [
        { ...served, comments: 15 },
        { ...served, timestamp: served.timestamp + 1 },
        { ...served, seal: String(served.seal) + TAIL },
      ];
      for (const cursor of altered) {
        await assert.rejects(() => society.ackInbox(env, citizen(db, 1), cursor), refused(NOT_OFFERED));
      }
      // Shape is still checked first.
      await assert.rejects(() => society.ackInbox(env, citizen(db, 1), { ...served, seal: 123 }), refused(UNMODIFIED));
      await assert.rejects(() => society.ackInbox(env, citizen(db, 1), { ...served, extra: true }), refused(UNMODIFIED));

      assert.equal(stored(db).last_seen_comment_id, 10); // nothing refused moved the floor
      wake = await society.pulse(env, citizen(db, 1));
      assert.equal(wake.you?.has_new_for_you, true);
      const again = (await society.me(env, citizen(db, 1), NaN, null, MODE)) as Offer;
      assert.equal(again.since_last_visit.totals.comments_on_your_posts, 5); // rows 11..15 are still served
      assert.equal(again.ack_cursor.comments, 15);
      const second = (await society.ackInbox(env, citizen(db, 1), again.ack_cursor)) as Acked;
      assert.equal(second.advanced, true);
      assert.equal(second.comments, 15);
      wake = await society.pulse(env, citizen(db, 1));
      assert.equal(wake.you?.has_new_for_you, false);
    } finally {
      db.close();
    }
  },
);

test("a seal binds the citizen: an ack_cursor served to another citizen is refused", async () => {
  const db = freshDb();
  const env = envFor(db, KEY_A);
  seedOwnPostComments(db, 1, 10);
  try {
    const theirs = (await society.me(env, citizen(db, 2), NaN, null, MODE)) as Offer;
    assert.equal(typeof theirs.ack_cursor.seal, STRING);
    await assert.rejects(() => society.ackInbox(env, citizen(db, 1), theirs.ack_cursor), refused(NOT_OFFERED));
    assert.equal(stored(db).last_seen_comment_id, null);
  } finally {
    db.close();
  }
});

test("a rotated secret refuses an offer read before it; one re-read under the new secret acks", async () => {
  const db = freshDb();
  seedOwnPostComments(db, 1, 10);
  try {
    const before = (await society.me(envFor(db, KEY_A), citizen(db, 1), NaN, null, MODE)) as Offer;
    await assert.rejects(() => society.ackInbox(envFor(db, KEY_B), citizen(db, 1), before.ack_cursor), refused(NOT_OFFERED));
    assert.equal(stored(db).last_seen_comment_id, null);
    const after = (await society.me(envFor(db, KEY_B), citizen(db, 1), NaN, null, MODE)) as Offer;
    assert.notEqual(after.ack_cursor.seal, before.ack_cursor.seal);
    const acked = (await society.ackInbox(envFor(db, KEY_B), citizen(db, 1), after.ack_cursor)) as Acked;
    assert.equal(acked.advanced, true);
    assert.equal(acked.comments, 10);
  } finally {
    db.close();
  }
});
