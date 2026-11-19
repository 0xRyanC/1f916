// The shared validator (test/helpers/json-schema.ts) is the offline half of
// every schema pin. Before this file it handled the keywords the schemas use
// EXCEPT additionalProperties — so the "additionalProperties": false pins on
// eight schemas (payout-wallets, treasury, provenance, docket, grant-proposal,
// funder-statement, legacy-manifest, listings-preimage) were declared but never
// enforced: a response with an extra key passed every offline test and live
// probe. This file pins all three forms so that pin is real:
//   false  -> a key not named in `properties` is refused
//   object -> each such key must validate against the object-form schema
//   true   -> (and absent) any key is allowed
// The false pin is anchored against a real schema (payout-wallets root), so a
// future silent no-op reddens on a genuine contract file, not a toy.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");

test("additionalProperties: false refuses a key not in properties", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  };
  assert.deepEqual(validate(schema, { a: "x" }), [], "a named key passes");
  assert.ok(
    validate(schema, { a: "x", surprise: 1 }).some(
      (e: string) => e.includes("surprise"),
    ),
    "an extra key is refused",
  );
});

test("additionalProperties is skipped for non-object values", () => {
  const noType = { properties: {}, additionalProperties: false };
  assert.deepEqual(validate(noType, ["a", "b"]), [], "an array has no keys to check");
  assert.deepEqual(
    validate(noType, "str"),
    [],
    "a string has no keys; no spurious type error from this branch",
  );
  const typed = { type: "object", properties: {}, additionalProperties: false };
  assert.deepEqual(validate(typed, "str"), ["$: expected type object, got string"], "a type error is the only error");
});

test("additionalProperties: object validates each extra key", () => {
  const schema = {
    type: "object",
    properties: { known: { type: "integer" } },
    additionalProperties: { type: "integer" },
  };
  assert.deepEqual(validate(schema, { known: 1, other: 2 }), [], "integer extra key passes");
  assert.ok(
    validate(schema, { other: "not-an-int" }).some(
      (e: string) => e.includes("other") && e.includes("type"),
    ),
    "a wrong-typed extra key is refused",
  );
});

test("additionalProperties: true allows any key", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: true,
  };
  assert.deepEqual(validate(schema, { a: "x", anything: { nested: true } }), [], "an extra key is allowed");
});

test("the false pin is live on a real schema: payout-wallets root", () => {
  const schema = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "payout-wallets.json"), "utf8"),
  ) as Record<string, unknown>;
  const valid = validate(schema, {
    now: 1789875166000,
    now_utc: "2026-09-20T03:32:46.000Z",
    handle: "attic-wren",
    wallets: [],
    note: "no payout wallets",
  });
  assert.deepEqual(valid, [], "a five-key response passes the real pin");
  assert.ok(
    validate(schema, {
      now: 1789875166000,
      now_utc: "2026-09-20T03:32:46.000Z",
      handle: "attic-wren",
      wallets: [],
      note: "no payout wallets",
      leaked_secret: true,
    }).some((e: string) => e.includes("leaked_secret")),
    "a sixth, undeclared key is now refused by the real pin",
  );
});

test("the object-form pin is live on a real schema: events totals_by_kind", () => {
  const schema = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "events.json"), "utf8"),
  ) as Record<string, unknown>;
  const totals = (schema.properties as Record<string, unknown>).totals_by_kind;
  assert.deepEqual(validate(totals, { kind_a: 3 }), [], "an integer count passes");
  assert.ok(
    validate(totals, { kind_a: "three" }).some(
      (e: string) => e.includes("kind_a"),
    ),
    "a non-integer count is refused",
  );
});
