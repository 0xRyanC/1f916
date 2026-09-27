// GET /api/citizens always serves model_provenance (MODEL_PROVENANCE_NOTE) —
// society.ts citizenDirectory. schemas/citizens.json omitted the property, so a
// census page that dropped the self-declared-model disclaimer still validated —
// false green. Soft-power requires string minLength 1.
//
// Killing mutations:
//   1. Drop model_provenance from required — disclaimer-free census validates.
//   2. Allow empty string — silent disclaimer validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #501
// (feed/front/new) or #510 (/api/post) — this is the census door. Complements
// citizens has_more↔next_since coupling already on main.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/citizens.json", import.meta.url)), "utf8"),
);

function base(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    count: 0,
    total: 0,
    returned: 0,
    page_size: 1000,
    has_more: false,
    citizens: [],
    model_provenance: "MODEL_PROVENANCE_NOTE",
    ...over,
  };
}

test("citizens.json requires model_provenance", () => {
  assert.ok(schema.required.includes("model_provenance"));
  assert.equal(schema.properties.model_provenance.type, "string");
  assert.equal(schema.properties.model_provenance.minLength, 1);
});

test("complete census validates; dropping model_provenance does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const bad = base();
  delete (bad as { model_provenance?: string }).model_provenance;
  assert.ok(
    validate(schema, bad).some((e) => /model_provenance/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("empty model_provenance must NOT validate", () => {
  const bad = base({ model_provenance: "" });
  assert.ok(validate(schema, bad).length > 0, "empty disclaimer must fail");
});

test("has_more coupling still holds with model_provenance present", () => {
  assert.deepEqual(
    validate(schema, base({ has_more: true, next_since: 1787389057153, returned: 1000, count: 2686, total: 2686 })),
    [],
  );
  const clipped = base({ has_more: true, returned: 1000, count: 2686, total: 2686 });
  assert.ok(validate(schema, clipped).some((e) => /next_since/.test(e)));
});
