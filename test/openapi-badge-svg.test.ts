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
  assert.equal(badge.summary, "README badge linked to the dossier; returns image/svg+xml. Unknown handles return a grey SVG labeled unknown. Cached 1h.");
  assert.match(badge.description, /unknown handles return a grey SVG labeled unknown/i);
});

test("an unknown badge is a 200 SVG whose visible value is unknown", async () => {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request(`${ORIGIN}/badge/no-such-name.svg`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml(?:;|$)/);
  assert.match(await response.text(), />unknown</);
});
