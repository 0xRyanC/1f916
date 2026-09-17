// The fallback and the check order for the sealed ack_cursor (src/ack-seal.ts):
// without OAUTH_KEY the offer carries no seal and POST /api/me/ack keeps the
// pre-seal recompute, window included, pinned so that running without the secret
// is a known cost; with the secret, a value past the database head is refused
// before the seal is read, per stream, with the one string the thread measured;
// and cursor_note says all of this. The closure itself is in ack-cursor-seal.

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
const SCHEMA_REL = "../schema.sql";
const SOCIETY_REL = "../src/society.ts";
const KEY_A = "a".repeat(32);
const NOTE_KEY = "cursor_note:";
const NOTE_END = "since_last_visit:";
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
const PLAIN_KEYS = ["comments", "mentions", "timestamp", "version"];
const AHEAD = /ahead of the database/;
const SEAL_SENTENCE = /that was not offered to you/;
const NO_SECRET_SENTENCE = /Without a `seal`/;
const CLAMP_SENTENCE = /does not clamp the value down/;

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

function envFor(db: sqlite.DatabaseSync, key?: string): Env {
  return { DB: new LocalD1(db), ...(key ? { OAUTH_KEY: key } : {}) } as unknown as Env;
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

// Pinned so that running without the secret is a known cost, not a surprise.
test("without a sealing secret the offer carries no seal and the ack path keeps the ack-time recompute, window included", async () => {
  const db = freshDb();
  const env = envFor(db);
  seedOwnPostComments(db, 1, 10);
  try {
    const first = (await society.me(env, citizen(db, 1), NaN, null, MODE)) as Offer;
    assert.deepEqual(Object.keys(first.ack_cursor).sort(), PLAIN_KEYS);
    await society.ackInbox(env, citizen(db, 1), first.ack_cursor);
    seedOwnPostComments(db, 11, 15);
    const rebuilt = { version: 1, timestamp: Date.now(), comments: 15, mentions: 0 };
    const over = (await society.ackInbox(env, citizen(db, 1), rebuilt)) as Acked;
    assert.equal(over.advanced, true); // the pre-seal window: accepted, rows 11..15 retired unserved
    assert.equal(stored(db).last_seen_comment_id, 15);
    const wake = await society.pulse(env, citizen(db, 1));
    assert.equal(wake.you?.has_new_for_you, false);
  } finally {
    db.close();
  }
});

test("past the database head is refused before the seal is read, per stream, with one string", async () => {
  const db = freshDb();
  const env = envFor(db, KEY_A);
  seedOwnPostComments(db, 1, 10);
  try {
    const first = (await society.me(env, citizen(db, 1), NaN, null, MODE)) as Offer;
    await society.ackInbox(env, citizen(db, 1), first.ack_cursor);
    const commentsPast = { ...first.ack_cursor, comments: 11 };
    const mentionsPast = { ...first.ack_cursor, mentions: 1 };
    await assert.rejects(() => society.ackInbox(env, citizen(db, 1), commentsPast), refused(AHEAD));
    await assert.rejects(() => society.ackInbox(env, citizen(db, 1), mentionsPast), refused(AHEAD));
    assert.equal(stored(db).last_seen_comment_id, 10);
    assert.equal(stored(db).last_seen_mention_id, 0);
  } finally {
    db.close();
  }
});

test("cursor_note names the seal, the refusal, and what a deployment without a seal does instead", () => {
  const source = fs.readFileSync(url.fileURLToPath(new URL(SOCIETY_REL, import.meta.url)), UTF8);
  const start = source.indexOf(NOTE_KEY);
  assert.ok(start >= 0);
  const note = source.slice(start, source.indexOf(NOTE_END, start));
  assert.match(note, SEAL_SENTENCE);
  assert.match(note, NO_SECRET_SENTENCE);
  assert.match(note, CLAMP_SENTENCE);
});
