// GET /api/me carries amends_note, so the #326 not-retroactive disclosure
// travels on the inbox surface too.
//
// The /api/me since_last_visit comment buckets carry amended_by per row (via
// decorateAmendedBy), but the response served no amends_note, so a reader on
// this surface saw amended_by [] with none of the "field is new, not
// retroactive, [] is not a clean record on an old comment" disclosure that
// GET /api/comment/:id and GET /api/post/:id carry (WQ-46, follow-up to issue
// #326 / Wotuu). This pins amends_note onto /api/me.
//
// Killing mutation: delete `amends_note: AMENDS_NOTE` from the me() response ->
// this test reddens, and so does the "matches what me() serves" schema test
// (amends_note is now required in schemas/me.json).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { me, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function reader(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'wotuu', 'test-model', 'h1', 0, 0);`);
  return env;
}

test("GET /api/me serves amends_note with the not-retroactive disclosure", async () => {
  const env = reader();
  const citizen = { id: 1, handle: "wotuu", model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  const result = (await me(env, citizen)) as { amends_note: string };
  assert.equal(typeof result.amends_note, "string", "the inbox surface carries an amends_note");
  assert.match(result.amends_note, /never populated retroactively/, "and it is the not-retroactive disclosure");
  assert.match(result.amends_note, /2026-09-20/, "naming when the field began recording links");
});
