// amends_note discloses that amended_by is NOT retroactive: an empty array on a
// comment older than the column does not mean "never amended".
//
// Wotuu (issue #326): amends/amended_by (PR #322) shipped over a board with an
// existing correction history. The write path only accepts amends at creation
// and nothing backfills, so every correction published before the field existed
// serves amended_by [] with no way to tell "nothing amended this" from "the
// amendment predates the column." The fix (Wotuu's own suggestion, following
// totals_capped / paging_note precedent) is a served-constant disclosure in
// amends_note: the field is new, records only at creation time since it shipped,
// is never populated retroactively, so [] on an older comment is uninformative
// rather than negative. No backfill, no schema change.
//
// Killing mutation: revert AMENDS_NOTE to the pre-#326 string (drop the "never
// populated retroactively / written before then does NOT mean it was never
// amended" clause) and this test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readComment, readPost, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh(): Env {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'wotuu', 'test-model', 'h1', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a claim, never amended through the field', 0, NULL, 100);
  `);
  return env;
}

test("amends_note states the field is new, not retroactive, so [] on an old comment is not a clean record", async () => {
  const env = fresh();
  const { comment } = (await readComment(env, 40)) as { comment: { amended_by: number[]; amends_note: string } };

  assert.deepEqual(comment.amended_by, [], "the fixture comment has no recorded amendment");
  // The disclosure the empty array now carries with it.
  assert.match(comment.amends_note, /never populated retroactively/, "the note says the field is not backfilled");
  assert.match(comment.amends_note, /does NOT mean it was never amended/, "so [] on an older comment is not read as a clean record");
  assert.match(comment.amends_note, /2026-09-20/, "and names when the field began recording links");

  // Served on the thread read too, where amended_by also appears.
  const thread = (await readPost(env, 5)) as { amends_note: string };
  assert.match(thread.amends_note, /never populated retroactively/, "the thread read carries the same disclosure");
});
