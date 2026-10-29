// GET /api/checkpoint always serves checkpoint_sequence beside the newest-written
// rows (#257 wire). schemas/checkpoint.json omitted it, so a response that dropped
// the liveness block still validated (false green). Soft-power pins the shape:
// recorded:true ↔ require head / attempts_per_pass / newest_written_id /
// ignored_since_newest_written / passes_since_newest_written; recorded:false
// forbids those numbers (platform refused sqlite_sequence).
//
// Killing mutations:
//   1. Drop checkpoint_sequence from top-level required — response without it validates.
//   2. Drop allOf recorded:true arm — recorded:true without head validates.
//   3. Relax attempts_per_pass away from const 2 — couple drifts from LOGS.length.
//   4. Always-require head — recorded:false (unread sequence) fails.
//
// Soft-power / cloudymcclouder. Schema-only follow-up to #257. Not a twin of
// cloudy treasury/proof work or gooseberry clients/*. Specimen fixtures only;
// no ungated live fetch.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/checkpoint.json", import.meta.url)), "utf8"),
);

const ROOT = "a".repeat(64);
const SIG = "A".repeat(43); // base64url-ish stand-in meeting ^[A-Za-z0-9_-]+$

function row(over: Record<string, unknown> = {}) {
  return {
    id: 2,
    log: "identity_events",
    tree_size: 10,
    root: ROOT,
    sig: SIG,
    created_at: 1,
    ...over,
  };
}

function sequenceRecorded(over: Record<string, unknown> = {}) {
  return {
    recorded: true,
    head: 4,
    attempts_per_pass: 2,
    attempted_pass_cron: "*/5 * * * *",
    newest_written_id: 2,
    ignored_since_newest_written: 2,
    passes_since_newest_written: 1,
    note: "n",
    ...over,
  };
}

function sequenceUnread(over: Record<string, unknown> = {}) {
  return {
    recorded: false,
    attempted_pass_cron: "*/5 * * * *",
    note: "n",
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    contract: "1f916.checkpoint.v1",
    registry_public_key: { kty: "OKP", crv: "Ed25519", x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    witness_dispatch: {
      recorded: true,
      last_attempt_at: 1,
      last_attempt_age_seconds: 0,
      last_status: 204,
      last_error: null,
      last_ok_at: 1,
      last_ok_age_seconds: 0,
      note: "n",
    },
    signed_payload_format: "1f916.checkpoint.v1:<log>:<tree_size>:<root>:<created_at>",
    countersignature_payload_format: "fmt",
    countersignature_note: "n",
    checkpoints: [row(), row({ id: 1, log: "ledger", tree_size: 5 })],
    checkpoint_sequence: sequenceRecorded(),
    leaves_are: "hashes",
    tree: "RFC 6962",
    how_to_verify: "n",
    ...over,
  };
}

test("checkpoint.json requires shaped checkpoint_sequence", () => {
  assert.ok(schema.required.includes("checkpoint_sequence"));
  const seq = schema.properties.checkpoint_sequence;
  assert.equal(seq.type, "object");
  for (const k of ["recorded", "attempted_pass_cron", "note"] as const) {
    assert.ok(seq.required.includes(k), k);
  }
  assert.equal(seq.properties.attempts_per_pass.const, 2);
  assert.ok(Array.isArray(seq.allOf) && seq.allOf.length >= 1, "recorded coupling");
});

test("recorded:true with full arithmetic validates", () => {
  assert.deepEqual(validate(schema, body()), []);
});

test("recorded:false without head numbers validates", () => {
  assert.deepEqual(validate(schema, body({ checkpoint_sequence: sequenceUnread() })), []);
});

test("dropping checkpoint_sequence must NOT validate", () => {
  const bad = body();
  delete (bad as Record<string, unknown>).checkpoint_sequence;
  assert.ok(
    validate(schema, bad).some((e: string) => /checkpoint_sequence/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("recorded:true without head must NOT validate", () => {
  const seq = sequenceRecorded();
  delete (seq as Record<string, unknown>).head;
  assert.ok(
    validate(schema, body({ checkpoint_sequence: seq })).some((e: string) => /head/.test(e)),
    validate(schema, body({ checkpoint_sequence: seq })).join("; "),
  );
});

test("recorded:false with dangling head must NOT validate", () => {
  const seq = sequenceUnread({ head: 4 });
  assert.ok(
    validate(schema, body({ checkpoint_sequence: seq })).some((e: string) => /head|forbidden/.test(e)),
    validate(schema, body({ checkpoint_sequence: seq })).join("; "),
  );
});

test("attempts_per_pass other than 2 must NOT validate", () => {
  const seq = sequenceRecorded({ attempts_per_pass: 3 });
  assert.ok(
    validate(schema, body({ checkpoint_sequence: seq })).some((e: string) => /attempts_per_pass|constant/.test(e)),
    validate(schema, body({ checkpoint_sequence: seq })).join("; "),
  );
});
