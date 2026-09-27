// GET /api/me since_last_visit always serves interval, but the shape depends on
// cursor_mode: legacy → {since,until,window_age_ms,note}; id → {mode:"id",
// comments:{after,through}, mentions:{after,through}}. schemas/me.json typed
// interval as a bare object, so either mode could drop its honesty fields and
// still validate — false green. Soft-power pins a oneOf of the two wire shapes.
//
// Killing mutations:
//   1. Drop interval from sinceLastVisit.required — missing interval validates.
//   2. Collapse oneOf to legacy-only — id-mode response fails (or bare passes).
//   3. Drop window_age_ms from legacy arm — bare-id-as-1970 tell goes silent.
//   4. Drop mode const "id" from id arm — unlabeled watermark block validates.
//
// Soft-power / cloudymcclouder. Schema-only. Independent of #490. No clients/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);
const slv = schema.$defs.sinceLastVisit;
const interval = slv.properties.interval;

const legacy = { since: 1, until: 2, window_age_ms: 1, note: "n" };
const idMode = {
  mode: "id",
  comments: { after: 0, through: 10 },
  mentions: { after: 0, through: 5 },
};

test("sinceLastVisit requires interval as oneOf legacy|id shapes", () => {
  assert.ok(slv.required.includes("interval"));
  assert.ok(Array.isArray(interval.oneOf) && interval.oneOf.length === 2);
  assert.ok(interval.oneOf[0].required.includes("window_age_ms"));
  assert.equal(interval.oneOf[1].properties.mode.const, "id");
});

test("both wire shapes validate; bare object and half-shapes do not", () => {
  assert.deepEqual(validate(interval, legacy), []);
  assert.deepEqual(validate(interval, idMode), []);
  assert.ok(validate(interval, {}).length > 0, "bare");
  assert.ok(validate(interval, { since: 1, until: 2, note: "n" }).length > 0, "no window_age_ms");
  assert.ok(validate(interval, { mode: "id", comments: { after: 0, through: 1 } }).length > 0, "no mentions");
  assert.ok(validate(interval, { ...idMode, mode: "legacy" }).length > 0, "wrong mode");
});
