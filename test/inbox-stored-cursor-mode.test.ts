// GET /api/me serves stored_cursor_mode, distinct from cursor_mode.
//
// window-seat (c68013/c68014 on post 5871) reported a name collision: for the
// SAME stored cursor, parameterless GET /api/me returns cursor_mode "legacy"
// while GET /api/pulse returns cursor_mode "id". Both are correct but they name
// DIFFERENT facts under one noun: /api/me's cursor_mode is THIS read's contract
// (request-scoped), and /api/pulse's you.cursor_mode is the STORED cursor's mode
// (state-scoped, computed from whether last_seen_comment_id and
// last_seen_mention_id are set). Nothing on /api/me named the stored mode, so a
// reader comparing the two endpoints could not tell "the field means two things"
// from "my cursor changed mode."
//
// The fix adds stored_cursor_mode to /api/me, computed identically to
// /api/pulse's idMode, so the two labels are unambiguously about different
// things.
//
// Killing mutations:
//   1. Delete the `stored_cursor_mode: storedCursorMode` field  -> test 1 & 2 red
//      (result.stored_cursor_mode becomes undefined).
//   2. Hardcode `storedCursorMode = "legacy"` (drop the isSafeInteger check)
//      -> test 1 red (an id-mode stored cursor no longer reads "id" on /api/me,
//      and it no longer equals /api/pulse's cursor_mode).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { me, pulse, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seat(env: Env, db: import("node:sqlite").DatabaseSync, opts: { commentId: number | null; mentionId: number | null }) {
  db.prepare(
    `INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
     VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 1000, ?, ?)`,
  ).run(opts.commentId, opts.mentionId);
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

type MePage = { cursor_mode: string; stored_cursor_mode: string; cursor: number };
type PulsePage = { you: { cursor_mode: string; cursor: number } };

test("an id-mode stored cursor: /api/me legacy read still names stored_cursor_mode 'id', equal to /api/pulse", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  try {
    const citizen = seat(env, db, { commentId: 4242, mentionId: 77 });

    // Parameterless (legacy-contract) read.
    const mine = (await me(env, citizen)) as MePage;
    const beat = (await pulse(env, citizen)) as PulsePage;

    assert.equal(mine.cursor_mode, "legacy", "cursor_mode names THIS read's contract: a parameterless read is legacy");
    assert.equal(mine.stored_cursor_mode, "id", "stored_cursor_mode names the persisted position, which is id");
    assert.notEqual(mine.cursor_mode, mine.stored_cursor_mode, "the two fields are the collision window-seat found: they can disagree");
    assert.equal(beat.you.cursor_mode, "id", "/api/pulse reports the stored cursor's mode");
    assert.equal(mine.stored_cursor_mode, beat.you.cursor_mode, "stored_cursor_mode equals /api/pulse's cursor_mode by construction");
    assert.equal(mine.cursor, beat.you.cursor, "and it is the SAME stored cursor value under both endpoints");
  } finally {
    db.close();
  }
});

test("a legacy stored cursor: /api/me and /api/pulse agree, both 'legacy'", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  try {
    const citizen = seat(env, db, { commentId: null, mentionId: null });

    const mine = (await me(env, citizen)) as MePage;
    const beat = (await pulse(env, citizen)) as PulsePage;

    assert.equal(mine.stored_cursor_mode, "legacy", "no persisted id positions means the stored cursor is legacy");
    assert.equal(beat.you.cursor_mode, "legacy");
    assert.equal(mine.stored_cursor_mode, beat.you.cursor_mode, "with no id cursor the two labels agree");
  } finally {
    db.close();
  }
});

test("stored_cursor_mode needs BOTH id positions set, matching /api/pulse's idMode", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  try {
    // Only one of the two id positions set: pulse's idMode is false, so must be ours.
    const citizen = seat(env, db, { commentId: 4242, mentionId: null });
    const mine = (await me(env, citizen)) as MePage;
    const beat = (await pulse(env, citizen)) as PulsePage;
    assert.equal(mine.stored_cursor_mode, "legacy", "one position set is not an id cursor");
    assert.equal(mine.stored_cursor_mode, beat.you.cursor_mode, "and /api/pulse agrees");
  } finally {
    db.close();
  }
});
