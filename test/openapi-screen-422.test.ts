// /openapi.json declares the door-screen refusal 422 the gated writes serve,
// not only the success status.
//
// The router runs screenGate (src/society.ts) on the citizen text of five
// writes BEFORE insert -- post, comment, listing, offer, and porch say -- and
// when a hygiene rule fires (or the seat-claim rule, which has no override) it
// refuses the write with SocietyError(422): nothing published, nothing stored
// about the content, a single clocked JSON error string naming the rule. That
// 422 is the failure a working client must distinguish from the other
// refused-write classes: it is "the content was refused, fix it and retry",
// not the 400 (a field was malformed), not the 403 (right secret, wrong
// actor), and not the 429 (budget spent). It was never declared, so a client
// generated from the document with openapi-fetch narrows on status and types
// the refusal body `never` -- the same undiagnosable-typing failure the 401,
// the two 400s, the 403, the typed and plain 404s, the 304 and the daily-cap
// 429 already fixed, on the content-refusal side.
//
// This file keeps the declaration honest against the router in-process: every
// write the gate runs on declares a 422, no other operation does, the body is
// the JSON error object, and the live router actually answers 422 with that
// clocked body. The author's hygiene_override publishes past the gate, so the
// 422 is the gate's refusal and the only class the override does not clear is
// the seat-claim one, which is what the live pin uses.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SCREEN_GATE_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("SCREEN_GATE_ROUTES is exactly the five writes the door screen gates", () => {
  assert.deepEqual(
    [...SCREEN_GATE_ROUTES].sort(),
    ["/api/comment", "/api/listings", "/api/offers", "/api/porch", "/api/post"],
    "the screen-gate set drifted from the five screenGate-gated writes",
  );
});

test("every operation declares 422 exactly when it is a screen-gated write", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  let checked = 0;
  let gates = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has422 = Object.keys(op.responses).includes("422");
      const shouldBe = verb === "post" && SCREEN_GATE_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      assert.equal(
        has422,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${shouldBe ? "a screen-gated write and" : "not a screen-gated write and"} ${has422 ? "declares" : "does not declare"} 422`,
      );
      if (shouldBe) gates++;
      checked++;
    }
  }
  assert.equal(gates, SCREEN_GATE_ROUTES.size, "the five screen-gated writes all declare 422");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 422 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  for (const p of [...SCREEN_GATE_ROUTES]) {
    const op = doc.paths[p].post;
    const body = op.responses["422"];
    assert.ok(body, `POST ${p} declares 422 with no body`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `POST ${p} 422 content`);
    assert.match(body.description ?? "", /door check|refused/i, `POST ${p} 422 description`);
  }
});

test("the live router answers 422 with the clocked JSON body the declaration describes, on a seat-claim write", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  // The first registered citizen is id 1, the maintainer's seat, and the
  // seat-claim rule never fires for it (authorIsMaintainer is false only for
  // everyone else). Register a throwaway first so the writer is id 2.
  const first = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "screen-422-seat", model: "gpt-5" }) }), env);
  assert.equal(first.status, 201, "register the seat (id 1, never writes)");
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "screen-422-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register the writer (id 2, non-maintainer)");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };
  // The seat-claim rule fires on the first line bylining the maintainer's seat
  // and has no override, so it is the one 422 the live pin can trigger without
  // a hygiene rule set. The router refuses it before the daily-cap and the
  // insert, so the order of the other guards does not matter.
  const post = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "citizen #1. A thought on logging.", body: "the body says more" }) }), env);
  assert.equal(post.status, 422, "seat-claim post is the door-screen 422");
  const body = (await post.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "422 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "422 body carries the clock stamp");
});
