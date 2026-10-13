// /openapi.json carries its own identity, so a token/example census of it can
// be dated and compared across reads, sessions and deploys (no-scheduler,
// c104659 on post 8427; WQ-344). Before this, the only document-level fields
// were x-now / x-now_utc, which move every request, so two readers (and the
// same reader twice) could not tell whether they counted the same document or
// name which deploy's regenerated fixture they measured. Two fields fix that:
//
//   x-examples-generated-at — when the response-example corpus was captured.
//   x-document-sha256       — the content hash, clock removed, so it is stable
//                             across reads of one deploy and a reader comparing
//                             two reads needs only to compare this string.
//
// What each test would miss if its guarantee were deleted is named on it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { openApi, openApiDocumentSha256, canonicalJson } from "../src/connect.ts";
import { EXAMPLES_GENERATED_AT } from "../src/openapi-examples.ts";
import { CAPTURED } from "../src/openapi-examples-captured.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

/** The newest `now` the captured corpus carries, computed independently of the
 *  source so the test pins the MEANING of x-examples-generated-at, not just
 *  that some ISO string is present. */
function newestCapturedNowISO(): string {
  let max = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) {
      if (k === "now" && typeof val === "number" && val > max) max = val;
      else walk(val);
    }
  };
  walk(CAPTURED);
  return new Date(max).toISOString();
}

test("the served /openapi.json carries both identity fields, and the hash is the content, not the clock (WQ-344)", async () => {
  const { env } = sqliteTestEnv(schema);
  const read = async () => (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Record<string, unknown>;
  const doc = await read();

  // x-examples-generated-at is the capture instant, equal to the newest clock
  // the examples carry (what a reader would compute scanning the document).
  // Missing field -> this reds; a wrong value (e.g. the min) -> this reds.
  assert.equal(doc["x-examples-generated-at"], newestCapturedNowISO(), "x-examples-generated-at is the newest captured `now`");
  assert.equal(doc["x-examples-generated-at"], EXAMPLES_GENERATED_AT, "and equals the exported constant the server used");
  assert.match(String(doc["x-examples-generated-at"]), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, "served as an ISO instant");

  // x-document-sha256 is 64 hex and reproduces when a reader reruns the recipe
  // over the served document. Drop the field at the serve site -> undefined,
  // this reds.
  const served = String(doc["x-document-sha256"]);
  assert.match(served, /^[0-9a-f]{64}$/, "x-document-sha256 is a sha256 hex digest");
  assert.equal(served, await openApiDocumentSha256(doc), "a reader rerunning the recipe over the served document reproduces the hash");
});

test("x-document-sha256 names the content and not the request clock: it is stable when only the clock moves (WQ-344)", async () => {
  // The whole point of the field. openApi() stamps x-now/x-now_utc from the
  // instant it is built; the hash recipe removes exactly those, so two builds a
  // day apart hash identically. KILLING MUTATION: remove "x-now" (or "x-now_utc")
  // from DOCUMENT_IDENTITY_OMIT in connect.ts and these two assertions red,
  // because the moving clock would then be inside the hashed bytes.
  const early = openApi(ORIGIN, 1_000) as Record<string, unknown>;
  const late = openApi(ORIGIN, 1_000 + 86_400_000) as Record<string, unknown>;
  assert.notEqual(early["x-now"], late["x-now"], "precondition: the two builds carry different clocks");
  assert.equal(await openApiDocumentSha256(early), await openApiDocumentSha256(late), "the content hash does not move with the clock");

  // And it is self-excluding: adding the field back in does not change the hash,
  // so the served document hashes to the value it carries.
  const withField = { ...early, "x-document-sha256": "deadbeef" };
  assert.equal(await openApiDocumentSha256(withField), await openApiDocumentSha256(early), "x-document-sha256 is excluded from its own hash");
});

test("canonicalJson sorts keys at every depth and drops whitespace, so the hash is order-independent", async () => {
  // The recipe must be reproducible regardless of how a reader's JSON library
  // orders keys; canonicalJson sorts at every depth. If it stopped sorting, two
  // key orders of the same content would hash differently and the "compare two
  // reads" promise would break.
  const a = { b: 1, a: { d: [3, 2], c: 4 } };
  const b = { a: { c: 4, d: [3, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b), "key order does not change the canonical form");
  assert.equal(canonicalJson(a), '{"a":{"c":4,"d":[3,2]},"b":1}', "sorted keys, array order kept, no whitespace");
});
