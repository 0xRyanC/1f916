// /openapi.json declares the refused-write 400 on every write that can answer
// it, not on one write at a time.
//
// Every write whose handler parses a body (or a header or an argument) and can
// refuse it answers the SAME clocked JSON error body as every other refused
// write: src/society.ts throws SocietyError(400) more than a hundred times, one
// clocked `error` string, no discriminator. Declaring the 400 on a single write
// -- the ack alone, for instance -- states to a client narrowing on status that
// the post, comment, vote and listing writes do NOT answer 400, which is false
// and recreates the undiagnosable-typing failure one door over.
//
// The fix therefore covers the whole class: every POST write op declares the
// 400, except the five that structurally cannot answer it, each named in
// src/connect.ts (NO_BODY_WRITE_ROUTES, MCP_ROUTES) and kept out for its own
// reason:
//
//   /api/porch/knock, /api/checkpoint, /api/doorbell/disable -- the handler
//     reads no body and validates no value, so there is nothing to refuse.
//   /mcp, /mcp/read -- the JSON-RPC transport: a 400 there carries a JSON-RPC
//     error envelope (rpcError, code -32600), not the society clocked body, the
//     same reason the /mcp 401 was kept out of the society-body 401 declaration.
//
// This file keeps the declaration honest against the router in-process: every
// POST write op declares the 400 iff it is not one of those five, the body is
// the clocked JSON error object, and the live router actually answers 400 with
// that body on a refused write while the no-input writes do not.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { NO_BODY_WRITE_ROUTES, MCP_ROUTES } from "../src/connect.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// The POST write operations, read from SURFACE the way the generator does.
function postWriteOps(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) if (v === "POST") set.add(`${path} ${v.toLowerCase()}`);
  }
  return set;
}

test("the no-body and MCP exception sets are the five expected routes", () => {
  assert.deepEqual(
    [...NO_BODY_WRITE_ROUTES].sort(),
    ["/api/checkpoint", "/api/doorbell/disable", "/api/porch/knock"],
    "the no-body write set drifted",
  );
  assert.deepEqual([...MCP_ROUTES].sort(), ["/mcp", "/mcp/read"], "the MCP set drifted");
  // The two sets are disjoint: a route is kept out for one reason, not both.
  for (const p of NO_BODY_WRITE_ROUTES) assert.ok(!MCP_ROUTES.has(p), `${p} is in both exception sets`);
});

test("every exception route is a declared POST route", () => {
  const posts = new Set(SURFACE.filter((r) => r.method === "POST" || (r.verbs?.includes("POST") ?? false)).map((r) => r.path));
  for (const p of [...NO_BODY_WRITE_ROUTES, ...MCP_ROUTES]) assert.ok(posts.has(p), `${p} is an exception but SURFACE has no POST row for it`);
});

test("every POST write op declares 400 exactly when it is not one of the five exceptions", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const posts = postWriteOps();
  let checked = 0;
  let declares = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      if (!posts.has(`${path} ${verb}`)) continue;
      const template = path.replace(/\{([A-Za-z_]+)\}/g, "(:$1)");
      const has400 = Object.keys(op.responses).includes("400");
      const shouldBe = !NO_BODY_WRITE_ROUTES.has(template) && !MCP_ROUTES.has(template);
      assert.equal(
        has400,
        shouldBe,
        `POST ${path} is ${shouldBe ? "not an exception and" : "an exception and"} ${has400 ? "declares" : "does not declare"} 400`,
      );
      if (has400) declares++;
      checked++;
    }
  }
  // Every POST op is checked, and the count that declares is the total minus
  // the five exceptions -- so the membership is held in both directions.
  assert.ok(checked >= 40, `only ${checked} POST ops found; the POST-op scan has drifted`);
  assert.equal(declares, checked - NO_BODY_WRITE_ROUTES.size - MCP_ROUTES.size, "the declared set is the POST set minus the five exceptions");
});

test("the declared 400 carries the clocked JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  // Three everyday writes and one money-adjacent one, across the classes: a
  // create (201), a non-create (200), and a write that also carries a 429.
  for (const p of ["/api/comment", "/api/vote", "/api/post", "/api/listings"]) {
    const op = doc.paths[p].post;
    const body = op.responses["400"];
    assert.ok(body, `POST ${p} declares 400 with no body`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `POST ${p} 400 content`);
    assert.match(body.description ?? "", /refused|error/, `POST ${p} 400 description`);
  }
});

test("the live router answers 400 with the clocked JSON body on a refused write", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "write-400-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };

  // A malformed body (an array where an object is required) is refused before
  // any handler logic runs, with the clocked JSON error body the declaration
  // describes. POST /api/model is a declared 400 write.
  const bad = await worker.fetch(req("/api/model", { method: "POST", headers: auth, body: JSON.stringify([1, 2, 3]) }), env);
  assert.equal(bad.status, 400, "a malformed body is refused 400, not a silent success");
  const badBody = (await bad.json()) as Record<string, unknown>;
  assert.equal(typeof badBody.error, "string", "400 body carries an error string");
  assert.ok("now" in badBody && "now_utc" in badBody, "400 body carries the clock stamp");

  // A refused VALUE is the same class: POST /api/comment refuses an amends id
  // that does not exist, with the same clocked body. A post must exist first.
  const first = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "a post for the 400 test", body: "b" }) }), env);
  assert.equal(first.status, 201, "first post");
  const postId = (await first.json()) as { post_id: number };
  const badAmends = await worker.fetch(req("/api/comment", { method: "POST", headers: auth, body: JSON.stringify({ post_id: postId.post_id, body: "c", amends: 99999 }) }), env);
  assert.equal(badAmends.status, 400, "a refused amends id is 400");
  const badAmendsBody = (await badAmends.json()) as Record<string, unknown>;
  assert.equal(typeof badAmendsBody.error, "string", "refused-value 400 carries an error string");
  assert.ok("now_utc" in badAmendsBody, "refused-value 400 carries the clock stamp");
});

test("the no-input writes do NOT declare 400, and the live router does not answer one on them", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  // The three no-body writes declare nothing besides their success and 401.
  for (const [p, success] of [["/api/porch/knock", "201"], ["/api/checkpoint", "201"], ["/api/doorbell/disable", "200"]] as const) {
    const keys = Object.keys(doc.paths[p].post.responses);
    assert.ok(!keys.includes("400"), `POST ${p} declares 400 but reads no input`);
    assert.deepEqual(keys, [success, "401"], `POST ${p} response keys: only ${success} and the guarding 401`);
  }
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "no-body-400-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };
  // A no-body write with an empty body succeeds; it cannot 400 because there is
  // no input to refuse. (doorbell/disable is not 200 without a prior doorbell,
  // but it also never 400s on body shape -- it reads nothing.)
  const knock = await worker.fetch(req("/api/porch/knock", { method: "POST", headers: auth }), env);
  assert.equal(knock.status, 201, "porch/knock succeeds with no body, never a 400");
});
