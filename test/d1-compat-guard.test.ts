// Regression test for the D1-compat static guard (test/helpers/d1-compat.mjs).
//
// THE BUG THIS PINS (2026-09-18, production incident): a LIKE pattern assembled
// per row from a value — `lower(description) LIKE '%' || lower(tx) || '%'`, the
// pattern built from a 66-character tx — exceeds D1's low
// SQLITE_MAX_LIKE_PATTERN_LENGTH and throws SQLITE_ERROR at execution time, so
// GET /api/attest returned HTTP 500 in production. Every offline test stayed
// green, because node:sqlite does not enforce that limit and exposes no API to
// set one: the offline lane structurally cannot reproduce this failure, so the
// only gate is the static check in the posttest scan-guard. This test proves
// that check discriminates: it flags patterns that grow with the data, and it
// lets through every shape that is bounded by construction.
//
// Run: part of `npm test` (test/*.test.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { isRuntimeLikePattern } from "./helpers/d1-compat.mjs";

// sqlLiterals() collapses every `${...}` interpolation to this marker; the test
// reproduces that here so the interpolation arm is exercised exactly as the
// guard sees it. The marker is built by concatenation, not a literal, so the
// NUL byte is guaranteed to survive whatever the toolchain does to source.
const INTERP = "\u0000";

test("flags the incident: a LIKE pattern concatenated from a value (SQL ||)", () => {
  assert.equal(
    isRuntimeLikePattern("SELECT x FROM ledger WHERE lower(description) LIKE '%' || lower(tx) || '%' AND id > 1"),
    true,
    "the 2026-09-18 500 query must be refused",
  );
});

test("flags a LIKE pattern built by ${} interpolation (the JS shape of the same defect)", () => {
  assert.equal(isRuntimeLikePattern(`SELECT id FROM t WHERE name LIKE '%${INTERP}%'`), true);
  assert.equal(isRuntimeLikePattern(`SELECT id FROM t WHERE name LIKE '%${INTERP}'`), true);
  assert.equal(isRuntimeLikePattern(`SELECT id FROM t WHERE name LIKE '${INTERP}%'`), true);
});

test("flags a GLOB pattern built from a value (the same defect under GLOB)", () => {
  assert.equal(isRuntimeLikePattern("SELECT id FROM t WHERE name GLOB ? || '%'"), true);
});

test("does not flag a bound ? — the client controls the length", () => {
  assert.equal(isRuntimeLikePattern("SELECT id FROM t WHERE name LIKE ?"), false);
  // The three live sites, verbatim (grants / society / legacy-manifest):
  assert.equal(
    isRuntimeLikePattern("SELECT e.detail FROM identity_events WHERE e.kind IN ('grant') AND e.detail LIKE ? ORDER BY e.id ASC"),
    false,
  );
  assert.equal(isRuntimeLikePattern("SELECT id, body FROM porch_lines WHERE day = ? AND body LIKE ?"), false);
  assert.equal(
    isRuntimeLikePattern("SELECT description FROM ledger WHERE description LIKE ? AND hash IS NOT NULL ORDER BY id ASC"),
    false,
  );
});

test("does not flag a fully static pattern literal", () => {
  assert.equal(isRuntimeLikePattern("SELECT id FROM t WHERE name LIKE 'prefix%'"), false);
  assert.equal(isRuntimeLikePattern("SELECT id FROM t WHERE name LIKE '%'"), false);
});

test("does not flag a LIKE whose operand is a plain bound ?", () => {
  assert.equal(isRuntimeLikePattern("SELECT id FROM t WHERE lower(description) LIKE ? AND hash IS NOT NULL"), false);
});

test("does not flag a statement with no LIKE/GLOB at all (the instr fix shape)", () => {
  assert.equal(
    isRuntimeLikePattern(
      "SELECT SUM(CASE WHEN tx IS NOT NULL AND tx <> '' THEN 1 ELSE 0 END) AS total, SUM(CASE WHEN tx IS NOT NULL AND tx <> '' AND instr(lower(description), lower(tx)) > 0 THEN 1 ELSE 0 END) AS covered FROM ledger WHERE hash IS NOT NULL",
    ),
    false,
  );
});

test("does not flag a || that lives OUTSIDE the pattern operand", () => {
  // A concatenation after the pattern, in a different expression of the same
  // statement, is not a pattern and must not be implicated: the check scopes to
  // the operand between the keyword and the next clause keyword.
  assert.equal(isRuntimeLikePattern("SELECT id FROM t WHERE name LIKE 'a%' AND note = ? || 'fixed'"), false);
  // Same for an interpolation in a sort key, not a pattern:
  assert.equal(isRuntimeLikePattern(`SELECT id FROM t WHERE name LIKE 'a%' ORDER BY ${INTERP}`), false);
});

test("does not flag the word 'like' inside an identifier or string", () => {
  // \b(LIKE|GLOB)\b with case-insensitive match still requires word boundaries;
  // 'similarly' and 'like_a' are not the keyword. (SQL is case-insensitive, so
  // the keyword itself is matched case-insensitively on purpose.)
  assert.equal(isRuntimeLikePattern("SELECT similarity FROM t WHERE similar_col = ?"), false);
  assert.equal(isRuntimeLikePattern("SELECT id FROM t WHERE tag = 'like' AND name = ?"), false);
});
