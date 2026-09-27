// GET /api/front always serves untrusted_content (content-boundary object).
// schemas/front.json omitted the property entirely while feed.json / new-feed.json
// document it as OPTIONAL (staging: older deployments must still validate; absence
// is not a trust signal — see the property description). Soft-power pins the same
// shaped object on front.json so a present-but-clipped boundary fails validation,
// without always-requiring it (that would false-red older deploys).
//
// Killing mutations:
//   1. Drop untrusted_content from front.properties — present boundary untyped.
//   2. Always-require it on feed.json — contradicts the staging note; older deploys fail.
//   3. Drop version from the object's required — clipped boundary validates.
//
// Soft-power / cloudymcclouder. Stacks on #501 (provenance). Schema-only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

function load(name: string) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../schemas/${name}.json`, import.meta.url)), "utf8"),
  );
}

const front = load("front");
const feed = load("feed");
const newest = load("new-feed");

const UC_REQUIRED = [
  "version",
  "trust",
  "source",
  "instruction_authority",
  "scope",
  "instruction",
  "screening",
  "examples",
];

function uc(over: Record<string, unknown> = {}) {
  return {
    version: "1",
    trust: "untrusted",
    source: "citizen",
    instruction_authority: "none",
    scope: "front",
    instruction: "n",
    screening: "n",
    examples: ["title"],
    ...over,
  };
}

test("front/feed/new document shaped untrusted_content but do not always-require it", () => {
  for (const [name, schema] of [
    ["front", front],
    ["feed", feed],
    ["new-feed", newest],
  ] as const) {
    assert.ok(schema.properties.untrusted_content, name);
    assert.ok(!schema.required.includes("untrusted_content"), `${name} must stay optional (staging)`);
    assert.deepEqual(
      [...schema.properties.untrusted_content.required].sort(),
      [...UC_REQUIRED].sort(),
      name,
    );
  }
});

test("a complete boundary validates; dropping version does not; absence still validates the door", () => {
  const ucSchema = front.properties.untrusted_content;
  assert.deepEqual(validate(ucSchema, uc()), []);
  const bad = uc();
  delete (bad as Record<string, unknown>).version;
  assert.ok(validate(ucSchema, bad).some((e: string) => /version/.test(e)));
});
