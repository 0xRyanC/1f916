// GET /api/anchors inserts every OpenTimestamps row `pending` and has NO pass
// that upgrades it (there is a confirmBase loop and a pollArchiveJob loop, but
// nothing for OTS), so all OTS rows stay pending forever with confirmed_at null
// even though the calendars' Bitcoin transactions are mined within hours. The
// served prose used to say a pending OTS row "is the calendar's promise until
// its Bitcoin transaction confirms" — telling a reader the row would flip. It
// never does server-side. Reported by Wotuu (#517).
//
// This pins the corrected prose: what_an_anchor_proves and how_to_verify.ots
// must state that OTS rows stay pending here (never upgraded), that confirmed_at
// stays null, and that `ots upgrade` on the served file is how a reader
// completes the proof — and must NOT carry the old flip-implying sentence.
//
// KILLING MUTATION: restore the old "is the calendar's promise until its Bitcoin
// transaction confirms" wording in src/anchors.ts -> the assertions go red.
// Confirmed red against a scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { listAnchors } from "../src/anchors.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at)
           VALUES (10, 'identity_events', 5, '${"a".repeat(64)}', 'sigA', 1790000000000);`);
  // One pending OTS row, as anchorCheckpoints inserts it: incomplete proof,
  // status pending, confirmed_at null. Nothing ever changes it.
  db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
           VALUES (10, 'ots', 'https://alice.btc.calendar.opentimestamps.org', 'cHJvb2Y=', 'pending', NULL, 1790000000000, NULL);`);
  return { env, db };
}

test("GET /api/anchors what_an_anchor_proves tells the truth about OTS rows staying pending (WQ/#517)", async () => {
  const { env } = fixture();
  const body = await listAnchors(env, undefined) as { what_an_anchor_proves: string; how_to_verify: { ots: string } };
  const proves = body.what_an_anchor_proves;

  // The old flip-implying claim must be gone.
  assert.doesNotMatch(
    proves,
    /is the calendar's promise until its Bitcoin transaction confirms/,
    "the prose must not tell a reader an OTS row will flip to confirmed server-side",
  );
  // The truth must be stated: OTS rows stay pending here and are never upgraded.
  assert.match(proves, /OpenTimestamps row stays `pending` here/, "must state OTS rows stay pending here");
  assert.match(proves, /never flips/, "must state the OTS status never flips");
  assert.match(proves, /confirmed_at` stays null/, "must state confirmed_at stays null on OTS rows");
  assert.match(proves, /ots upgrade/, "must point the reader to ots upgrade to complete the proof");

  // how_to_verify.ots must carry the same honesty, not the flip-implying wording.
  const ots = body.how_to_verify.ots;
  assert.doesNotMatch(ots, /pending until the calendar's Bitcoin transaction confirms/, "how_to_verify.ots must not imply a server-side flip");
  assert.match(ots, /never upgrades it/, "how_to_verify.ots must state the registry never upgrades the row");
  assert.match(ots, /ots upgrade/, "how_to_verify.ots must name ots upgrade as the completion path");
});
