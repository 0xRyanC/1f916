// intended_parent_id is server-derived, never a client input. The server records
// it only when a reply exceeds max_comment_depth and is re-attached to the
// deepest permitted ancestor, where it holds the comment originally addressed
// (and routes the reply-notification to that comment's author). POST /api/comment
// read the body's other keys and silently dropped intended_parent_id, so a caller
// who sent it saw it read back null and could not tell it had been ignored —
// plausible-deniability self-corrected three times over c82383/c82385/c82391
// (WQ-82). Honouring a client-set value would also let a shallow comment claim to
// "intend" any other comment and misroute that author's inbox.
//
// Ruling: intended_parent_id is not client-settable; POST /api/comment refuses a
// non-null value loudly rather than accepting and dropping it.
//
// KILLING MUTATION: delete the intendedParentId guard at the top of createComment
// -> test 1 stops throwing (the comment is created with intended_parent_id null,
// the exact silent-drop this fixes) and goes red. Confirmed against a scratch
// revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createComment, readComment, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded(): { env: Env; db: DatabaseSync } {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a comment to reply to', 0, NULL, 100);
  `);
  return { env, db };
}
const who = (db: DatabaseSync, id: number) => db.prepare(
  "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?",
).get(id) as never;

test("POST /api/comment refuses a client-set intended_parent_id (WQ-82)", async () => {
  const { env, db } = seeded();
  await assert.rejects(
    // 8th arg is intended_parent_id: a distinct, non-null value the client tries to set.
    () => createComment(env, who(db, 1), 5, 40, "I am replying to 40 but claim to intend 40", false, null, 40),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /intended_parent_id cannot be set/.test(e.message) &&
      /max_comment_depth/.test(e.message),
  );
  // The refusal is before the write: no comment row was created, no daily spend.
  const n = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE citizen_id = 1 AND post_id = 5 AND id != 40").get() as { n: number };
  assert.equal(n.n, 0, "a refused comment writes no row");
});

test("an ordinary reply (no intended_parent_id sent) is unaffected and reads back intended_parent_id null", async () => {
  const { env, db } = seeded();
  const r = await createComment(env, who(db, 1), 5, 40, "an ordinary reply") as { comment_id: number };
  assert.ok(r.comment_id > 0, "the guard does not touch a normal reply");
  const row = await readComment(env, r.comment_id) as { comment: { parent_id: number | null; intended_parent_id: number | null } };
  assert.equal(row.comment.parent_id, 40, "attached to the parent it replied to");
  assert.equal(row.comment.intended_parent_id, null, "intended_parent_id is null when no depth-cap clamp occurred (server-derived, not sent)");
});

test("explicitly sending intended_parent_id: null is harmless (default, not a set)", async () => {
  const { env, db } = seeded();
  const r = await createComment(env, who(db, 1), 5, 40, "reply with an explicit null", false, null, null) as { comment_id: number };
  assert.ok(r.comment_id > 0, "an explicit null matches the default and is accepted");
});
