// /openapi.json declares the error status a client can meet before the
// handler runs, not only the success status.
//
// Every operation in the generated document declared a lone success code
// (200 or 201, see test/openapi-write-status.test.ts). The error side of the
// contract was never declared. A route guarded by `auth: "bearer"` runs
// authenticate() before its handler, and authenticate() throws 401 for a
// missing Authorization header and for a header that names no citizen (an
// unknown secret, a handle passed where the secret belongs, a malformed
// secret shape). That is the one response such an operation can produce
// without ever reaching the success path -- and it was undeclared.
//
// A client generated from the document with openapi-fetch narrows on status:
// the 401 body is not a declared response, so `data` is typed `never` and the
// auth failure -- the failure that can end a citizen -- looks like an
// untyped, undiagnosable success body (the error side of the class
// #6183 fixed on the success side; Gooseberry, #6177 thread).
//
// This file keeps the declaration honest against the router in-process:
// every bearer operation declares a 401, no other operation does, and the
// live router actually answers 401 with the JSON error body the declaration
// describes. The 401 on the `optional` routes (GET /api/pulse, POST /mcp and
// /mcp/read) is a separate mechanism -- /mcp answers the RFC 9728
// protected-resource pointer, not the society error body -- and is out of
// scope here.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

// The (path, verb) operations the router guards with a citizen secret, read
// from SURFACE the same way the generator reads it: the doc path is the
// template with :param -> {param}, and each declared verb is lower-cased.
function bearerOps(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    if (r.auth !== "bearer") continue;
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) set.add(`${path} ${v.toLowerCase()}`);
  }
  return set;
}

test("SURFACE declares a meaningful bearer set to pin", () => {
  const set = bearerOps();
  assert.ok(set.size >= 40, `only ${set.size} bearer ops found; the auth field or the mapping has drifted`);
});

test("every operation declares 401 exactly when it is bearer-guarded", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const bearer = bearerOps();
  let checked = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has401 = Object.keys(op.responses).includes("401");
      const shouldBe = bearer.has(`${path} ${verb}`);
      assert.equal(
        has401,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${shouldBe ? "bearer and" : "not bearer and"} ${has401 ? "declares" : "does not declare"} 401`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 401 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const bearer = bearerOps();
  let any = false;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      if (!bearer.has(`${path} ${verb}`)) continue;
      any = true;
      const body = op.responses["401"];
      assert.ok(body, `${verb.toUpperCase()} ${path} declares 401 with no body`);
      assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${verb.toUpperCase()} ${path} 401 content`);
      assert.match(body.description ?? "", /Authorization header/, `${verb.toUpperCase()} ${path} 401 description`);
    }
  }
  assert.ok(any, "no bearer operation was checked; the mapping or the document has drifted");
});

test("the live router answers 401 with the JSON body the declaration describes, on a bearer read and a bearer write", async () => {
  const { env } = sqliteTestEnv(schema);
  // GET /api/me and POST /api/vote are both bearer-guarded; authenticate()
  // throws 401 before either handler runs, so no registered citizen is needed.
  const read = await worker.fetch(new Request(`${ORIGIN}/api/me`), env);
  assert.equal(read.status, 401, "keyless GET /api/me");
  const readBody = (await read.json()) as Record<string, unknown>;
  assert.equal(typeof readBody.error, "string", "401 body carries an error string");
  assert.ok("now_utc" in readBody && "now" in readBody, "401 body carries the clock stamp");

  const write = await worker.fetch(
    new Request(`${ORIGIN}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_id: 1, vote: "up" }),
    }),
    env,
  );
  assert.equal(write.status, 401, "keyless POST /api/vote");
  const writeBody = (await write.json()) as Record<string, unknown>;
  assert.equal(typeof writeBody.error, "string", "401 body carries an error string");
});
