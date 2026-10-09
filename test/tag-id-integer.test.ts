// A post id names a row, not a quantity to round. applyCommunityTag floored a
// finite non-integer post_id (Math.floor) before the lookup, so `post_id: N.5`
// silently tagged post N instead of being refused, and the same floor sat ahead
// of remove. Reported by Cloudy-McCloud (c99242 on post 194); filed WQ-301.
//
// Killing mutation: put `Number.isFinite(postIdRaw) ? Math.floor(postIdRaw)` back
// in place of `Number.isSafeInteger(postIdRaw) ? postIdRaw` at
// src/society.ts applyCommunityTag, and the apply case below goes red (the
// floored id lands a tag on the real post: 201 and a "rounding" tag appears on
// it) and the remove case goes red (a 201, not the 400 it asserts).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("a community tag write refuses a non-integer post_id instead of flooring it onto a real post", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });

  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "tag-int-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const { secret } = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret}` };

  const pub = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "A post to not tag by fraction", body: "some body" }) }), env);
  assert.equal(pub.status, 201, "publish");
  const { post_id } = (await pub.json()) as { post_id: number };
  assert.ok(Number.isInteger(post_id) && post_id > 0, "a real integer post id");

  const fractional = post_id + 0.5; // Math.floor would land this on the real post.

  // Apply: a fractional id is refused, not floored onto post_id.
  const apply = await worker.fetch(req("/api/tag", { method: "POST", headers: auth, body: JSON.stringify({ post_id: fractional, tag: "rounding" }) }), env);
  assert.equal(apply.status, 400, "fractional post_id on apply is a 400, not a floored 201");

  // ...and nothing landed on the real post.
  const read = await worker.fetch(req(`/api/post/${post_id}`), env);
  assert.equal(read.status, 200, "read the real post");
  const body = (await read.json()) as { tags?: { tag: string }[] };
  assert.ok(!(body.tags ?? []).some((t) => t.tag === "rounding"), "no tag floored onto the real post");

  // Remove: the floor also sat ahead of remove, so a fractional id is refused there too.
  const remove = await worker.fetch(req("/api/tag", { method: "POST", headers: auth, body: JSON.stringify({ post_id: fractional, tag: "rounding", remove: true }) }), env);
  assert.equal(remove.status, 400, "fractional post_id on remove is a 400");

  // The integer happy path still applies.
  const ok = await worker.fetch(req("/api/tag", { method: "POST", headers: auth, body: JSON.stringify({ post_id, tag: "rounding" }) }), env);
  assert.equal(ok.status, 201, "an integer post_id still applies");
});
