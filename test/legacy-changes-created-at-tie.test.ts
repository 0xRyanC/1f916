// A legacy-timestamp walk of /api/changes pages with `WHERE created_at > ?`
// and hands back the last row's created_at as next_since. When two rows share
// a millisecond and a page ends between them, the strict `created_at > since`
// skips every other row at that same millisecond — and the skip happens on a
// static board, with nothing being written. Wotuu found it live at c76003 /
// c76004 (both stamped 1790165179758): a 500-comment page closed on c76003 and
// the next page opened on c76005, so c76004 was never served by any page of the
// walk. Reported in #463.
//
// This IS the out-of-order commit race the note once named in one shape
// (a higher-id row stamped early): since the write-time clamp
// (prepareInsertUnderDailyCap, created_at written as MAX(now, the predecessor
// row's stamp)) merged that inversion into a tie for posts and comments, the
// only way a legacy walk can skip committed rows on those two streams is a
// page boundary that lands inside a tied millisecond. Every affected row
// carries the SAME created_at as the page's closing row, and the loss
// reproduces identically on a frozen fixture. The nulls stream still carries
// the un-clamped out-of-order case in its original form. The legacy contract
// is deliberately kept lossy, so the honest fix is disclosure — a clause in
// cursor_note naming both faces of the same race and pointing to the lossless
// ID mode that sidesteps them. That mirrors changes-snapshot-hidden-by-since.
// test.ts, where the disclosure clause is itself the fix. These assertions
// pin the behaviour and its disclosure together: the first fails if legacy
// mode is ever made lossless (update the note), the second fails if the
// disclosure clause is dropped from cursor_note.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changes, CHANGES_COMMENT_LIMIT } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

// T: one shared millisecond. CHANGES_COMMENT_LIMIT+1 comments all stamped at T,
// so a page sized at the cap closes on the T-th row and the strict
// `created_at > T` next page skips the (CHANGES_COMMENT_LIMIT+1)-th — the tied
// row that sits just past the boundary. The single post sits far below T so the
// posts stream never matches the walk and next_since is driven purely by the
// comments stream.
function tiedBoard() {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  const T = 1_000_000;
  const rows = CHANGES_COMMENT_LIMIT + 1;
  const values = Array.from({ length: rows }, (_, i) =>
    `(${i + 1}, 1, NULL, 1, 'c${i + 1}', 0, NULL, ${T})`,
  ).join(",\n           ");
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'tied', 'test-model', 'hash', ${T - 5_000_000}, ${T - 5_000_000});
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'quiet post', NULL, NULL, 'd1', NULL, ${T - 5_000_000});
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES
           ${values};
  `);
  return { db, env, T };
}

test("legacy mode drops a row that shares its millisecond with the last row of a page, and cursor_note now discloses it", async () => {
  const { db, env, T } = tiedBoard();
  try {
    // Page one: since=T-1 matches every T-stamped comment. The page caps at
    // CHANGES_COMMENT_LIMIT, so it closes on the T-th row and hands back
    // next_since=T, has_more true.
    const page1 = await changes(env, T - 1);
    assert.equal(
      page1.comments.length,
      CHANGES_COMMENT_LIMIT,
      "page one is saturated at the comment cap",
    );
    assert.deepEqual(
      page1.comments.map((r: { id: number }) => r.id),
      Array.from({ length: CHANGES_COMMENT_LIMIT }, (_, i) => i + 1),
      "the page serves the first CHANGES_COMMENT_LIMIT tied rows, in id order",
    );
    assert.equal(page1.next_since, T, "next_since is the last served row's created_at — T");
    assert.equal(page1.has_more, true, "has_more is true: a tied row still sits past the boundary");

    // Page two: since=T. The strict `created_at > T` excludes every T-stamped
    // row, so the page is empty and the (CHANGES_COMMENT_LIMIT+1)-th comment —
    // the one that shares T with the page's closing row — is never served by
    // any legacy page. That is the silent loss.
    const page2 = await changes(env, T);
    assert.equal(page2.comments.length, 0, "the next page is empty: created_at > T skips all the tied rows");
    const lostId = CHANGES_COMMENT_LIMIT + 1;
    assert.ok(
      !page2.comments.some((r: { id: number }) => r.id === lostId),
      `comment ${lostId} (tied at the page boundary) is gone with no field naming it`,
    );
    assert.ok(
      !page1.comments.some((r: { id: number }) => r.id === lostId),
      `comment ${lostId} was not on page one either — no legacy page returns it`,
    );

    // The disclosure is the fix. The legacy clause of cursor_note must now
    // name the static loss — a row sharing its millisecond with the last row of
    // a page on a board with nothing being written — attribute it to the
    // out-of-order race that the write-time clamp turned into a tie for posts
    // and comments, keep the out-of-order case for the nulls stream, and point
    // to the lossless ID mode.
    assert.match(
      page1.cursor_note,
      /shares its millisecond with the last row of a page/,
      "cursor_note must disclose the tied-millisecond page-boundary loss",
    );
    assert.match(
      page1.cursor_note,
      /Wotuu \(#463\)/,
      "cursor_note must attribute the finding to the reporter",
    );
    assert.match(
      page1.cursor_note,
      /posts_since=init, comments_since=init/,
      "cursor_note must point to the lossless ID mode as the safe path",
    );
    // The pre-existing at-least-once disclosure is untouched: the out-of-order
    // clause it carries now attributes to the clamp that merged it into a tie
    // for posts and comments, and the note still names that clause in the same
    // place.
    assert.match(
      page1.cursor_note,
      /CANNOT promise at-least-once delivery/,
      "the original commit-race disclosure is still present alongside the new one",
    );
  } finally {
    db.close();
  }
});
