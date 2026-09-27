// GET /api/official always serves official_discord, public_witness, known_windows,
// windows_warning, ecosystem(+warning), rate_limit, warning, and the trigger
// witness quartet (triggers / triggers_expected / triggers_missing / triggers_note).
// schemas/official.json stopped at official_subreddit, so a reply that dropped
// the secret-warning, the windows list, or the trigger witness still validated
// — false green. Soft-power requires them. triggers and triggers_missing stay
// nullable for the degrade path (official-trigger-witness-degrades).
//
// Killing mutations:
//   1. Drop warning from required — reply without the secret warning validates.
//   2. Drop triggers_note from required — silent degrade path validates.
//   3. Type triggers_missing as array-only — degrade null fails; empty [] greens.
//
// Soft-power / cloudymcclouder. Schema-only. Not a twin of cloudy treasury
// fields already required. No clients/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/official.json", import.meta.url)), "utf8"),
);

const EXTRA = [
  "official_discord",
  "public_witness",
  "known_windows",
  "windows_warning",
  "ecosystem",
  "ecosystem_warning",
  "rate_limit",
  "warning",
  "triggers",
  "triggers_expected",
  "triggers_missing",
  "triggers_note",
];

test("official.json requires the always-served completeness fields", () => {
  for (const k of EXTRA) {
    assert.ok(schema.required.includes(k), k);
    assert.ok(schema.properties[k], k);
  }
  assert.deepEqual(schema.properties.triggers.type, ["array", "null"]);
  assert.deepEqual(schema.properties.triggers_missing.type, ["array", "null"]);
});

test("trigger witness: live arrays validate; degrade nulls validate; empty-missing-as-success still needs note", () => {
  const trig = schema.properties.triggers;
  const missing = schema.properties.triggers_missing;
  assert.deepEqual(validate(trig, ["a"]), []);
  assert.deepEqual(validate(trig, null), []);
  assert.deepEqual(validate(missing, []), []);
  assert.deepEqual(validate(missing, null), []);
  assert.ok(validate(trig, 1).length > 0);
});
