// The OTS upgrade pass (issue #517): pending OpenTimestamps rows older than an
// hour, two per pass, oldest first, each asked of its own calendar at the
// address the decoded proof names — GET /timestamp/<attestee-message-hex>,
// where the attestee message is the stored op chain replayed from the digest
// (probed live: calendars 404 a root-digest lookup; PR #648 probe history).
// A calendar answer carrying a BitcoinBlockHeaderAttestation flips the row:
// the completed proof is stored (prefix + stamp-prefix + upgraded terminal
// node), status becomes `confirmed`, and confirmed_at is set. Anything else —
// no attestation yet, a calendar error, an undecodable proof — leaves the row
// exactly as it was for the next pass.
//
// Killing mutations, each checked against a scratch copy of src/anchors.ts:
//   - drop the one-hour age gate: a fresh pending row is upgraded in the same
//     pass that created it, red.
//   - LIMIT 2 -> LIMIT 200: three pending rows upgrade in one pass, red.
//   - serve the raw calendar response as the whole proof: the served file no
//     longer parses as a detached file (it must be prefix + stamp-prefix +
//     upgraded terminal node), red.
//   - confirm on a response WITHOUT the attestation tag: a pending row flips
//     on an unmined batch, red.
//   - skip the UPDATE: rows stay pending and ots_upgraded stays 0, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, decodeOtsTail, hasBitcoinAttestation, otsFile, sha256Bytes, b64, type AnchorDeps } from "../src/anchors.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT_A = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const ROOT_B = "ce96f39e1f5a53795fb9b505c6c56c053438744fa7df5abd3026de0a7ea541d3";
const T0 = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const CAL = "https://alice.btc.calendar.opentimestamps.org";

// A plausible upgraded terminal node: the calendar's current serialization for
// the attestee message once the batch is mined — no ops, a bitcoin attestation
// (tag 83dfd307) carrying an 8-byte block height.
const UPGRADED_NODE = new Uint8Array([0x00, 0x83, 0xdf, 0xd3, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x87, 0x6d, 0x2c]);
// Same shape, no attestation: the calendar still holds only a pending one.
const PENDING_NODE = (() => {
  const uri = new TextEncoder().encode(CAL);
  const out = new Uint8Array(1 + 8 + 1 + uri.length);
  out[0] = 0x00;
  out.set([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e], 1);
  out[9] = uri.length;
  out.set(uri, 10);
  return out;
})();

function fixture(rows: { id: number; checkpoint: number; target: string; proof: string; age_ms: number }[]) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES
    (10, 'identity_events', 5, '${ROOT_A}', 'sigA', ${T0 - 1000}),
    (11, 'ledger', 2, '${ROOT_B}', 'sigB', ${T0 - 900})`);
  // An archive row fresh at T0 keeps the 55-minute archive gate shut, so the
  // pass exercises only the OTS paths under test. Explicit ids: the ots rows
  // below are addressed by id in the assertions.
  db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
           VALUES (100, 10, 'archive', 'attempt:x', NULL, 'failed', 'gate', ${T0}, NULL);`);
  for (const r of rows) {
    db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
             VALUES (${r.id}, ${r.checkpoint}, 'ots', '${r.target}', '${r.proof}', 'pending', NULL, ${T0 - r.age_ms}, NULL);`);
  }
  return { env, db };
}

// A stored proof whose tail decodes to the minimal shape: terminal `00` +
// pending attestation, no ops — so the attestee message IS the file digest,
// known to the test before the pass runs.
async function seedProof(digestSeed: number): Promise<{ proof: string; digest: Uint8Array }> {
  const digest = await sha256Bytes(`seed-${digestSeed}`);
  const uri = new TextEncoder().encode(CAL);
  const tail = new Uint8Array(1 + 8 + 1 + uri.length);
  tail[0] = 0x00;
  tail.set([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e], 1);
  tail[9] = uri.length;
  tail.set(uri, 10);
  return { proof: b64(otsFile(digest, tail)), digest };
}

function depsWith(upgradeResponse: () => Response, calls: string[]): AnchorDeps {
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
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

test("decodeOtsTail computes the attestee message of a linear op chain", async () => {
  // digest -> append(0x41) -> sha256 -> prepend(0x42,0x43) -> terminal pending
  const digest = await sha256Bytes("chain-seed");
  const uri = new TextEncoder().encode(CAL);
  const tail = new Uint8Array([0xf0, 0x01, 0x41, 0x08, 0xf1, 0x02, 0x42, 0x43, 0x08, 0x00, ...[0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e], uri.length, ...uri]);
  const decoded = await decodeOtsTail(tail, digest);
  assert.ok(decoded, "a linear chain must decode");
  // attestee message: the ops are append(0x41) -> sha256 -> prepend(0x4243)
  // -> sha256, so the intermediate hash after the first sha256 is load-bearing.
  const step1 = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...digest, 0x41])));
  const step2 = new Uint8Array([0x42, 0x43, ...step1]);
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", step2));
  assert.deepEqual([...decoded.attesteeMsg], [...expected]);
  assert.equal(decoded.attestationStart, 9);
});

test("decodeOtsTail refuses shapes the pass must not rewrite", async () => {
  const digest = await sha256Bytes("refuse-seed");
  const uri = new TextEncoder().encode(CAL);
  const pendTag = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];
  // A branch separator: not produced by a direct digest submission.
  assert.equal(await decodeOtsTail(new Uint8Array([0xff, 0x08, 0x00, ...pendTag, uri.length, ...uri]), digest), null);
  // Already-terminal bitcoin attestation instead of a pending one.
  assert.equal(await decodeOtsTail(new Uint8Array([0x00, 0x83, 0xdf, 0xd3, 0x07, 0, 0, 0, 0, 0, 1, 2, 3]), digest), null);
  // Unsupported op.
  assert.equal(await decodeOtsTail(new Uint8Array([0x67, 0x00, ...pendTag, uri.length, ...uri]), digest), null);
  // Trailing garbage after the terminal node.
  assert.equal(await decodeOtsTail(new Uint8Array([0x00, ...pendTag, uri.length, ...uri, 0x99]), digest), null);
});

test("a pending OTS row older than an hour upgrades and confirms when the calendar returns a Bitcoin attestation", async () => {
  const { proof, digest } = await seedProof(1);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 1);
  assert.equal(report.confirmed, 1);
  const stampCalls = calls.filter((c) => c.includes("/timestamp/"));
  assert.deepEqual(stampCalls, [`GET ${CAL}/timestamp/${Buffer.from(digest).toString("hex")}`]);
  const row = db.prepare("SELECT status, confirmed_at, proof FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number; proof: string };
  assert.equal(row.status, "confirmed");
  assert.equal(row.confirmed_at, T0);
  // The stored proof is the original file prefix and stamp up to the terminal
  // node, plus the upgraded terminal node: still a detached-timestamp file
  // carrying the digest, now with the attestation.
  const stored = Buffer.from(row.proof, "base64");
  assert.ok(hasBitcoinAttestation(new Uint8Array(stored)));
  const original = Buffer.from(proof, "base64");
  assert.deepEqual([...stored.slice(0, original.length - PENDING_NODE.length)], [...original.slice(0, original.length - PENDING_NODE.length)]);
});

test("a calendar answer without a Bitcoin attestation leaves the row pending and untouched", async () => {
  const { proof } = await seedProof(2);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(PENDING_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(report.confirmed, 0);
  const row = db.prepare("SELECT status, confirmed_at, proof FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number | null; proof: string };
  assert.equal(row.status, "pending");
  assert.equal(row.confirmed_at, null);
  assert.equal(row.proof, proof, "the stored proof must not change without an attestation");
});

test("a calendar error leaves the row pending for the next pass and records no failure", async () => {
  const { proof } = await seedProof(3);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response("nope", { status: 404 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(report.failed, 0, "a dead calendar is an upgrade poll miss, not an anchor failure");
  const row = db.prepare("SELECT status, confirmed_at, error FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number | null; error: string | null };
  assert.equal(row.status, "pending");
  assert.equal(row.confirmed_at, null);
  assert.equal(row.error, null, "the error column documents the original attempt, not upgrade polls");
});

test("a row younger than the hour gate is not asked", async () => {
  const { proof } = await seedProof(4);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 5 * 60 * 1000 }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(calls.filter((c) => c.includes("/timestamp/")).length, 0, "no calendar call for a row inside the age gate");
  const row = db.prepare("SELECT status FROM anchors WHERE id = 1").get() as { status: string };
  assert.equal(row.status, "pending");
});

test("two rows per pass, oldest first", async () => {
  const p1 = await seedProof(5);
  const p2 = await seedProof(6);
  const p3 = await seedProof(7);
  const { env, db } = fixture([
    { id: 1, checkpoint: 10, target: CAL, proof: p1.proof, age_ms: 3 * HOUR },
    { id: 2, checkpoint: 10, target: "https://bob.btc.calendar.opentimestamps.org", proof: p2.proof, age_ms: 2 * HOUR },
    { id: 3, checkpoint: 11, target: CAL, proof: p3.proof, age_ms: HOUR + 1 },
  ]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 2, "exactly the per-pass limit upgrades");
  assert.equal(calls.filter((c) => c.includes("/timestamp/")).length, 2);
  const statuses = db.prepare("SELECT id, status FROM anchors WHERE kind = 'ots' ORDER BY id").all() as { id: number; status: string }[];
  const byId = new Map(statuses.map((s) => [s.id, s.status]));
  assert.equal(byId.get(1), "confirmed");
  assert.equal(byId.get(2), "confirmed");
  assert.equal(byId.get(3), "pending", "the newest of the three waits for the next pass");
});
