// Issue #335 (TeaShaman-cyber): extend the /api/changes conditional-revalidation
// pattern (ETag + If-None-Match, keeping no-store) to an exact-object read,
// GET /api/comment/:id. The validator is a hash of the semantic representation
// itself (commentEtag over readComment's clock-free return), so it is complete
// BY CONSTRUCTION: no changeable input can be missed the way a hand-picked key
// set could. A 304 is only reachable by a caller that actually sent
// If-None-Match, and only a live match authorizes reuse.
//
// The acceptance shape from #335 this pins:
//  - the 200 carries an ETag and keeps no-store;
//  - 304 only when If-None-Match was sent, with no body and the same ETag;
//  - the tag CHANGES for every mutation that changes the representation
//    (moderation redaction; a new amender in amended_by) -- the stale-304
//    falsifiers: point 8 of the issue's acceptance shape;
//  - a missing comment is still 404, never a 304.
//
// Killing mutation: make commentEtag hash only payload.comment.id (dropping the
// rest) and the two stale-304 tests below go red -- a moderated or newly
// amended comment would keep answering 304 with its old body.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createComment, readComment, type Citizen, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker, { commentEtag } from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh(): { env: Env; db: DatabaseSync; full: Env } {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash-1', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'the original claim', 0, NULL, 100);
  `);
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  return { env, db, full };
}

function who(db: DatabaseSync, id: number): Citizen {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?",
  ).get(id) as never;
}

const get = (full: Env, headers: Record<string, string> = {}) =>
  worker.fetch(new Request("http://t/api/comment/40", { headers }), full as never);

test("the 200 carries an ETag and keeps no-store, and the tag is stable while the content is", async () => {
  const { full } = fresh();
  const r1 = await get(full);
  assert.equal(r1.status, 200);
  const etag = r1.headers.get("ETag");
  assert.ok(etag && /^"c1-[0-9a-f]{32}"$/.test(etag), `expected a c1 ETag, got ${etag}`);
  assert.equal(r1.headers.get("Cache-Control"), "no-store", "no-store stays");

  const r2 = await get(full);
  assert.equal(r2.headers.get("ETag"), etag, "an unchanged comment hashes to the same tag");
  const body = await r2.json();
  assert.equal(body.comment.id, 40, "without If-None-Match the full body is served");
});

test("a matching If-None-Match answers 304 with no body and the same ETag", async () => {
  const { full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  const r = await get(full, { "If-None-Match": etag });
  assert.equal(r.status, 304);
  assert.equal(r.headers.get("ETag"), etag);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(await r.text(), "", "a 304 carries no body");
});

test("STALE-304 falsifier: moderating the comment changes the tag, so a held tag no longer 304s", async () => {
  const { db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  // Collapse redacts the body on the public read (applyModState), a different
  // representation. A validator that missed mod_state would answer 304 and the
  // caller would keep the pre-moderation body.
  db.exec("UPDATE comments SET mod_state = 'collapsed' WHERE id = 40");
  const r = await get(full, { "If-None-Match": etag });
  assert.equal(r.status, 200, "a moderated comment must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "the tag moved with the representation");
});

test("STALE-304 falsifier: a new amender changes the tag (amended_by is load-bearing)", async () => {
  const { env, db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  await createComment(env, who(db, 1), 5, null, "correcting my own claim above", false, 40);
  const r = await get(full, { "If-None-Match": etag });
  assert.equal(r.status, 200, "a newly amended comment must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "amended_by is in the validated representation");
});

test("a missing comment is still 404, never a 304", async () => {
  const { full } = fresh();
  const r = await worker.fetch(
    new Request("http://t/api/comment/999", { headers: { "If-None-Match": '"c1-00000000000000000000000000000000"' } }),
    full as never,
  );
  assert.equal(r.status, 404, "a 304 is never said about a comment that does not exist");
});

test("commentEtag is complete: representations differing only in a semantic field hash differently", async () => {
  const { env } = fresh();
  const base = await readComment(env, 40);
  const tagBase = await commentEtag(base);
  // Same content, same tag.
  assert.equal(await commentEtag(await readComment(env, 40)), tagBase);
  // A representation that differs only in amended_by must hash differently --
  // the property that makes the stale-304 falsifiers above bite.
  const withAmender = JSON.parse(JSON.stringify(base));
  withAmender.comment.amended_by = [41];
  assert.notEqual(await commentEtag(withAmender), tagBase, "amended_by change moves the tag");
});
