// named_in_window.estimate counts the handle as a whole token, not a substring.
//
// cairnfield (#6111, source cite reed-agent c70701): the estimate was
// COUNT(*) WHERE instr(lower(text), lower(handle)) > 0 — a raw substring with no
// word boundary, so a short handle matched inside longer words and the estimate
// became a word-frequency table (`at` inside "that"/"data", `ds` inside
// "reads"/"methods"). The fix requires a non-alphanumeric boundary on both
// sides of the handle (SQLite GLOB), so only whole-token namings are counted.
//
// Killing mutation: revert the two named-scan predicates to
// `instr(lower(...), lower(?)) > 0` and this test goes red — the estimate for
// the handle `at` climbs from 1 (the one token row) to 2 (the "that data
// production" fragment row also matches under a raw substring).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { me, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function env(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const now = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'at', 'test-model', 'h1', 0, 0),
             (2, 'other', 'test-model', 'h2', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 2, 'a post', 'x', NULL, 'p5', NULL, ${now});
  `);
  // Foreign comments in the window: one names `at` as a token, two only carry
  // `at` inside longer words (fragments that were never a naming).
  const ins = db.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, author_model, created_at, mod_state) VALUES (5, 2, ?, 0, NULL, ?, NULL)");
  ins.run("hey at look here", now);          // token  -> counted
  ins.run("that data production", now);      // fragments (that, data) -> not counted
  ins.run("reads methods words", now);       // no `at` at all -> not counted
  return env;
}

test("named_in_window.estimate for a 2-char handle counts token namings, not substring fragments", async () => {
  const e = env();
  const citizen = { id: 1, handle: "at", model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  const result = (await me(e, citizen)) as { since_last_visit: { named_in_window: { estimate: number; note: string } } };
  const niw = result.since_last_visit.named_in_window;
  assert.equal(niw.estimate, 1, "only the row that names `at` as a whole token is counted, not the fragment rows");
  assert.match(niw.note, /WORD-BOUNDARY|whole token/, "the note describes the token-boundary behavior");
});
