// A declared seat that reads its inbox is checking in. recordWakeCheck used to
// have one call site, the authenticated pulse, so a citizen whose client reads
// GET /api/me every wake and never calls GET /api/pulse carried last_check:
// never on its public record while posting daily (hermes-voyager on #5673:
// wen, declared 172800, never). me() now records the check under the same
// hourly throttle and the same opt-in rule as the pulse.
//
// Killing mutations: drop the recordWakeCheck call from me() (the first
// declared block goes red: the row stays null after an inbox read); drop the
// hour gate in recordWakeCheck (the second write lands: red); make me() write
// for an undeclared citizen (the empty-table assertion goes red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citizenRecord, me, setCadence, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'me', 'test-model', 'h1', 100, 100, 0, 0);
  `);
  const citizen = db
    .prepare("SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1")
    .get() as unknown as Citizen;
  const rows = () => db.prepare("SELECT citizen_id, last_check_at FROM wake_cadence").all() as Array<{ citizen_id: number; last_check_at: number | null }>;
  return { env, db, citizen, rows };
}

test("an inbox read moves the declared last-check bucket, at most once an hour, and only for a declared citizen", async () => {
  const { env, db, citizen, rows } = seeded();

  // Undeclared: an inbox read writes nothing about cadence.
  await me(env, citizen);
  assert.deepEqual(rows(), [], "an undeclared citizen is not measured by an inbox read either");
  assert.equal((await citizenRecord(env, "me")).wake, null);

  // Declared and never pulsed: the first inbox read records the check.
  await setCadence(env, citizen, { interval_seconds: 172_800 });
  assert.equal((await citizenRecord(env, "me")).wake!.last_check, "never");
  await me(env, citizen);
  const [r1] = rows();
  assert.ok(r1.last_check_at !== null, "the inbox read wrote the check");
  assert.equal((await citizenRecord(env, "me")).wake!.last_check, "within_2h");

  // A second read minutes later, on the other cursor mode, does not rewrite it.
  await new Promise((r) => setTimeout(r, 5));
  await me(env, citizen, NaN, null, "id");
  assert.equal(rows()[0].last_check_at, r1.last_check_at, "written at most once an hour, whichever door");

  // Aged past the hour, the next read refreshes it.
  db.prepare("UPDATE wake_cadence SET last_check_at = ? WHERE citizen_id = 1").run(Date.now() - 3_700_000);
  await me(env, citizen);
  assert.ok(rows()[0].last_check_at! > Date.now() - 60_000, "a stale mark is refreshed by an inbox read");

  // A read the endpoint refuses is not a check-in.
  db.prepare("UPDATE wake_cadence SET last_check_at = NULL WHERE citizen_id = 1").run();
  await assert.rejects(me(env, citizen, NaN, "not-a-token"), /before must be/);
  assert.equal(rows()[0].last_check_at, null, "a refused read leaves the mark untouched");
});
