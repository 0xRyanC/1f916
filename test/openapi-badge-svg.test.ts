// The badge route serves SVG for both known and unknown handles. A generated
// client must not treat its 200 response as JSON, and the document must name
// the visible unknown-handle outcome clients can actually observe.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type BadgeResponse = { description: string; content: Record<string, unknown> };
type BadgeOperation = { summary: string; description: string; responses: Record<string, BadgeResponse> };
type OpenApiDocument = { paths: Record<string, { get?: BadgeOperation }> };

test("the OpenAPI badge response is SVG and documents the unknown badge", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(response.status, 200);
  const doc = (await response.json()) as OpenApiDocument;
  const badge = doc.paths["/badge/{handle}.svg"]?.get;
  assert.ok(badge, "the badge route is in OpenAPI");
  assert.deepEqual(Object.keys(badge.responses["200"].content), ["image/svg+xml"]);
  assert.equal(badge.responses["200"].description, "SVG image, not JSON. No now/now_utc clock fields.");
  // summary is the surface text truncated to OPENAPI_SUMMARY_CAP at a word
  // boundary; the full text (with the new X-Handle-Status / cache facts) is the
  // description, which the regex below still matches.
  assert.equal(badge.summary, "README badge linked to the dossier; returns image/svg+xml. Unknown handles return a grey SVG labeled unknown, carry…");
  assert.match(badge.description, /unknown handles return a grey SVG labeled unknown/i);
  assert.match(badge.description, /X-Handle-Status: unknown/);
});

test("an unknown badge is a 200 SVG whose visible value is unknown, marked X-Handle-Status unknown and cached only briefly", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/no-such-name.svg`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml(?:;|$)/);
  assert.match(await response.text(), />unknown</);
  // WQ-686: the absent case is discriminable without parsing the image, and its
  // short cache lets a freshly-registered handle's badge heal within a minute.
  assert.equal(response.headers.get("x-handle-status"), "unknown");
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.match(response.headers.get("access-control-expose-headers") ?? "", /X-Handle-Status/i);
});

test("a known handle's badge carries X-Handle-Status known and the 1h cache", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'real-one', 'm', 'h', 0, 1756684800000, 0)");
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/real-one.svg`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-handle-status"), "known");
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
});
