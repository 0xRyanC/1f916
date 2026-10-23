// The OTS upgrade pass (issue #517): pending OpenTimestamps rows older than an
// hour, two per pass, oldest first, each asked of its own calendar. A calendar
// answer carrying a BitcoinBlockHeaderAttestation flips the row: the completed
// proof is stored (prefix + upgraded tail), status becomes `confirmed`, and
// confirmed_at is set. Anything else — no attestation yet, a calendar error —
// leaves the row exactly as it was for the next pass.
//
// Killing mutations, each checked against a scratch copy of src/anchors.ts:
//   - drop the one-hour age gate: a fresh pending row is upgraded in the same
//     pass that created it, red.
//   - LIMIT 2 -> LIMIT 200: three pending rows upgrade in one pass, red.
//   - store the raw calendar response without the prefix: the served proof no
//     longer parses as a detached file (it must be prefix + upgraded tail), red.
//   - confirm on a response WITHOUT the attestation tag: a pending row flips
//     on an unmined batch, red.
//   - skip the UPDATE: rows stay pending and ots_upgraded stays 0, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, hasBitcoinAttestation, otsFile, sha256Bytes, b64, type AnchorDeps } from "../src/anchors.ts";
import { checkpointPayload } from "../src/checkpoint.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT_A = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const ROOT_B = "ce96f39e1f5a53795fb9b505c6c56c053438744fa7df5abd3026de0a7ea541d3";
const T0 = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;

// A plausible calendar response: the same bytes an `ots upgrade` returns once
// the batch is mined — the upgraded timestamp tail carrying the Bitcoin
// attestation op tag (0x83dfd307) followed by an 8-byte block height.
const UPGRADED_TAIL = new Uint8Array([0xf0, 0x08, ...Array(10).fill(0x01), 0x83, 0xdf, 0xd3, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x87, 0x6d, 0x2c]);
// Same shape, no attestation: the calendar still holds only pending attestations.
const PENDING_TAIL = new Uint8Array([0xf0, 0x08, ...Array(10).fill(0x01), 0x83, 0xdc, 0xd3, 0x07, 0x20, ...Array(32).fill(0x02)]);

function fixture(rows: { id: number; checkpoint: number; target: string; proof: string; age_ms: number }[]) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES
    (10, 'identity_events', 5, '${ROOT_A}', 'sigA', ${T0 - 1000}),
    (11, 'ledger', 2, '${ROOT_B}', 'sigB', ${T0 - 900})`);
  // An archive row fresh at T0 keeps the 55-minute archive gate shut, so the
  // the pass exercises only the OTS paths under test. Explicit ids: the ots
  // rows below are addressed by id in the assertions.
  db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
           VALUES (100, 10, 'archive', 'attempt:x', NULL, 'failed', 'gate', ${T0}, NULL);`);
  for (const r of rows) {
    db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
             VALUES (${r.id}, ${r.checkpoint}, 'ots', '${r.target}', '${r.proof}', 'pending', NULL, ${T0 - r.age_ms}, NULL);`);
  }
  return { env, db };
}

function depsWith(upgradeResponse: () => Response, calls: string[]): AnchorDeps {
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      calls.push(`POST ${url}`);
      // New submissions for checkpoints without anchors still happen in the
      // same pass; serve them a minimal initial timestamp.
      if (url.endsWith("/digest")) return new Response(new Uint8Array([0xf0, 0x08, 0x01]), { status: 200 });
      return upgradeResponse();
    }) as typeof fetch,
    submitBase: async () => {
      throw new Error("submitBase must not be called by the upgrade pass");
    },
    confirmBase: async () => "pending" as const,
  } as AnchorDeps & { calls: string[] };
}

async function seedProof(digestSeed: number): Promise<string> {
  const digest = await sha256Bytes(`seed-${digestSeed}`);
  // A minimal calendar timestamp tail; its content is not parsed, only split off.
  return b64(otsFile(digest, new Uint8Array([0xf0, 0x08, 0x01])));
}

test("a pending OTS row older than an hour upgrades and confirms when the calendar returns a Bitcoin attestation", async () => {
  const proof = await seedProof(1);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: "https://alice.btc.calendar.opentimestamps.org", proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_TAIL, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 1);
  assert.equal(report.confirmed, 1);
  const stampCalls = calls.filter((c) => c.endsWith("/timestamp"));
  assert.deepEqual(stampCalls, ["POST https://alice.btc.calendar.opentimestamps.org/timestamp"]);
  const row = db.prepare("SELECT status, confirmed_at, proof FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number; proof: string };
  assert.equal(row.status, "confirmed");
  assert.equal(row.confirmed_at, T0);
  // The stored proof is the original file prefix + the upgraded tail: still a
  // detached-timestamp file carrying the digest, now with the attestation.
  const stored = Buffer.from(row.proof, "base64");
  assert.ok(hasBitcoinAttestation(new Uint8Array(stored)));
  const original = Buffer.from(proof, "base64");
  assert.deepEqual([...stored.slice(0, original.length - 2)], [...original.slice(0, original.length - 2)]);
});

test("a calendar answer without a Bitcoin attestation leaves the row pending and untouched", async () => {
  const proof = await seedProof(2);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: "https://bob.btc.calendar.opentimestamps.org", proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(PENDING_TAIL, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(report.confirmed, 0);
  const row = db.prepare("SELECT status, confirmed_at, proof FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number | null; proof: string };
  assert.equal(row.status, "pending");
  assert.equal(row.confirmed_at, null);
  assert.equal(row.proof, proof, "the stored proof must not change without an attestation");
});

test("a calendar error leaves the row pending for the next pass and records no failure", async () => {
  const proof = await seedProof(3);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: "https://finney.calendar.eternitywall.com", proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response("nope", { status: 502 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(report.failed, 0, "a dead calendar is an upgrade poll miss, not an anchor failure");
  const row = db.prepare("SELECT status, confirmed_at, error FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number | null; error: string | null };
  assert.equal(row.status, "pending");
  assert.equal(row.confirmed_at, null);
  assert.equal(row.error, null, "the error column documents the original attempt, not upgrade polls");
});

test("a row younger than the hour gate is not asked", async () => {
  const proof = await seedProof(4);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: "https://alice.btc.calendar.opentimestamps.org", proof, age_ms: 5 * 60 * 1000 }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_TAIL, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(calls.filter((c) => c.endsWith("/timestamp")).length, 0, "no calendar call for a row inside the age gate");
  const row = db.prepare("SELECT status FROM anchors WHERE id = 1").get() as { status: string };
  assert.equal(row.status, "pending");
});

test("two rows per pass, oldest first", async () => {
  const p1 = await seedProof(5);
  const p2 = await seedProof(6);
  const p3 = await seedProof(7);
  const { env, db } = fixture([
    { id: 1, checkpoint: 10, target: "https://alice.btc.calendar.opentimestamps.org", proof: p1, age_ms: 3 * HOUR },
    { id: 2, checkpoint: 10, target: "https://bob.btc.calendar.opentimestamps.org", proof: p2, age_ms: 2 * HOUR },
    { id: 3, checkpoint: 11, target: "https://alice.btc.calendar.opentimestamps.org", proof: p3, age_ms: HOUR + 1 },
  ]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_TAIL, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 2, "exactly the per-pass limit upgrades");
  assert.equal(calls.filter((c) => c.endsWith("/timestamp")).length, 2);
  const statuses = db.prepare("SELECT id, status FROM anchors ORDER BY id").all() as { id: number; status: string }[];
  const byId = new Map(statuses.map((s) => [s.id, s.status]));
  assert.equal(byId.get(1), "confirmed");
  assert.equal(byId.get(2), "confirmed");
  assert.equal(byId.get(3), "pending", "the newest of the three waits for the next pass");
});
