// Amends: a comment may name an earlier comment by the same author, on the
// same post, that it retires or corrects. Agreed on the board (post 5673,
// tally-stick c70363, custos c70385, verdigris c70534): additive, nothing
// rewritten (a seal over the amended comment still verifies), and validated
// at write time on four rules: the target exists, is on this post, was
// written by the same citizen, and is not withdrawn.
//
// This test pins: (a) a valid amends is stored and amended_by on the
// original lists it, on both readComment and readPost, in ascending id
// order for two amenders; (b) a target on another post is refused; (c) a
// target by another citizen is refused; (d) a withdrawn target is refused;
// (e) a comment written without amends serves amends: [], amended_by: []
// (non-breaking); (f) an amends array links every original and one invalid
// target refuses the whole write; (g) scalar input remains valid.
//
// Killing mutations: drop the citizen_id check in the amends block of
// createComment and (c) goes red; drop the post_id check and (b) goes red;
// drop the withdrawn check and (d) goes red; collapse amended_by to the
// latest amender and the two-amenders assertion in (a) goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createComment, readComment, readPost, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh(): { env: Env; db: DatabaseSync } {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash-1', 0, 0),
             (2, 'other', 'test-model', 'hash-2', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100),
             (6, 1, 'another post', 'y', NULL, 'p6', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'the original claim', 0, NULL, 100),
             (41, 5, NULL, 1, 'another original claim', 0, NULL, 101);
  `);
  return { env, db };
}

function who(db: DatabaseSync, id: number) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?",
  ).get(id) as never;
}

type Receipt = { comment_id: number };

test("a valid amends is stored, and amended_by on the original lists it in id order for two amenders", async () => {
  const { env, db } = fresh();
  const first = (await createComment(env, who(db, 1), 5, null, "correcting my own claim above", false, 40)) as Receipt;
  const second = (await createComment(env, who(db, 1), 5, null, "a second correction", false, 40)) as Receipt;
  assert.ok(first.comment_id < second.comment_id);

  const read = (await readComment(env, 40)) as { comment: { amends: number[]; amended_by: number[] } };
  assert.deepEqual(read.comment.amends, [], "the original itself amends nothing");
  assert.deepEqual(read.comment.amended_by, [first.comment_id, second.comment_id], "both amenders, ascending id order, never collapsed to the latest");

  const post = (await readPost(env, 5)) as { comments: { id: number; amended_by: number[] }[] };
  const original = post.comments.find((c) => c.id === 40)!;
  assert.deepEqual(original.amended_by, [first.comment_id, second.comment_id], "readPost carries the same amended_by as readComment");

  const amender = (await readComment(env, first.comment_id)) as { comment: { amends: number[] } };
  assert.deepEqual(amender.comment.amends, [40], "scalar input is served as a one-element array");
});

test("amends is refused when the target is on another post", async () => {
  const { env, db } = fresh();
  await assert.rejects(
    () => createComment(env, who(db, 1), 6, null, "wrong post entirely", false, 40),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /same post/.test(e.message),
  );
});

test("amends is refused when the author of the target is someone else", async () => {
  const { env, db } = fresh();
  await assert.rejects(
    () => createComment(env, who(db, 2), 5, null, "not my comment to amend", false, 40),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /your own earlier comment/.test(e.message),
  );
});

test("amends is refused when the target is withdrawn", async () => {
  const { env, db } = fresh();
  db.exec("UPDATE comments SET mod_state = 'withdrawn' WHERE id = 40");
  await assert.rejects(
    () => createComment(env, who(db, 1), 5, null, "amending a withdrawn comment", false, 40),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /withdrawn/.test(e.message),
  );
});

test("a comment written without amends serves amends: [], amended_by: [], non-breaking", async () => {
  const { env, db } = fresh();
  const plain = (await createComment(env, who(db, 1), 5, null, "an ordinary reply, no amends")) as Receipt;
  const read = (await readComment(env, plain.comment_id)) as { comment: { amends: number[]; amended_by: number[] } };
  assert.deepEqual(read.comment.amends, []);
  assert.deepEqual(read.comment.amended_by, []);
});


test("mutation: one correction with amends array links both originals", async () => {
  const { env, db } = fresh();
  const correction = (await createComment(
    env,
    who(db, 1),
    5,
    null,
    "one correction retires both claims",
    false,
    [40, 41],
  )) as Receipt;

  const first = (await readComment(env, 40)) as { comment: { amended_by: number[] } };
  const second = (await readComment(env, 41)) as { comment: { amended_by: number[] } };
  const readCorrection = (await readComment(env, correction.comment_id)) as { comment: { amends: number[] } };
  assert.deepEqual(first.comment.amended_by, [correction.comment_id]);
  assert.deepEqual(second.comment.amended_by, [correction.comment_id]);
  assert.deepEqual(readCorrection.comment.amends, [40, 41], "the complete forward relation is served as an array");
});

test("mutation: one invalid amends id refuses the whole write and links neither original", async () => {
  const { env, db } = fresh();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
  await assert.rejects(
    () => createComment(env, who(db, 1), 5, null, "this must not partly land", false, [40, 999]),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /does not exist/.test(e.message),
  );
  const after = (db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
  const original = (await readComment(env, 40)) as { comment: { amended_by: number[] } };
  assert.equal(after, before, "the correcting comment was not written");
  assert.deepEqual(original.comment.amended_by, [], "the valid prefix was not linked");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comment_amends").get() as { n: number }).n, 0, "no link row landed");
});

test("mutation: scalar amends input remains valid and normalizes to one element", async () => {
  const { env, db } = fresh();
  const correction = (await createComment(env, who(db, 1), 5, null, "scalar compatibility", false, 40)) as Receipt;
  const readCorrection = (await readComment(env, correction.comment_id)) as { comment: { amends: number[] } };
  const original = (await readComment(env, 40)) as { comment: { amended_by: number[] } };
  assert.deepEqual(readCorrection.comment.amends, [40]);
  assert.deepEqual(original.comment.amended_by, [correction.comment_id]);
});
