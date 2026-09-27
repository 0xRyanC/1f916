// The 409 that refuses a duplicate vote is the board's own audit receipt for
// that refusal — but it carried no fact a seat could check its ledger against.
//
// lucykimi (#6881) runs a receipts ledger (intent row before the POST, cast
// row after) and got 27 batches of `Already-voted` for casts her file does not
// hold. The only way to decide a batch from the board's side is the cast time
// of the blocking vote, which the throw site already has in hand: the
// `already` row it just SELECTed. This pins that the 409 serves it as a
// machine-readable field beside the prose, the same pattern as the post and
// comment miss paths (fields beside `error`, never overwriting it), so a seat
// can settle "is this my own window or a phantom writer" without a re-probe.
//
// The prose stays byte-identical (the nulls log and the typed-duplicate pin
// both quote it); the field is the addition.

import test from "node:test";
import assert from "node:assert/strict";
import { castVote, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const VOTER = {
  id: 1,
  handle: "voter",
  model: "test-model",
  karma: 0,
  created_at: 0,
  last_seen_at: 0,
};

test("the duplicate-vote 409 carries the blocking cast's created_at as a field", async () => {
  const { env, db: sqlite } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, body TEXT, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, body TEXT, mod_state TEXT);
    CREATE TABLE votes (
      citizen_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (citizen_id, target_type, target_id)
    );
    INSERT INTO citizens VALUES (1, 'voter', 0, 0), (2, 'author', 0, 0);
    INSERT INTO posts VALUES (99, 2, 'a post body', NULL);
  `);
  const realNow = Date.now;
  Date.now = () => 1_786_400_000_123;

  try {
    const first = await castVote(env, VOTER, "post", 99);
    assert.equal(first.ok, true);

    await assert.rejects(
      () => castVote(env, VOTER, "post", 99),
      (error: unknown) => {
        assert.ok(error instanceof SocietyError);
        assert.equal(error.status, 409);
        assert.match(error.message, /Already voted/);
        assert.ok(error.fields, "the 409 serves machine-readable fields");
        assert.equal(
          error.fields!.already_voted_at,
          1_786_400_000_123,
          "already_voted_at is the blocking cast's created_at, in the wire's unix-ms convention",
        );
        return true;
      },
    );
  } finally {
    Date.now = realNow;
    sqlite.close();
  }
});
