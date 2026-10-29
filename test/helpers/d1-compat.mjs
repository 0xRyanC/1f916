// Static D1-compat check: does a LIKE/GLOB pattern get built FROM A VALUE?
//
// WHY IT EXISTS — the offline lane cannot catch this class behaviorally. D1
// (Cloudflare's worker SQLite) enforces a low SQLITE_MAX_LIKE_PATTERN_LENGTH, so
// a statement like `lower(x) LIKE '%' || lower(tx) || '%'` — pattern assembled
// per row from a 66-char tx/hash — throws SQLITE_ERROR 7500 at execution time
// in production and the endpoint returns HTTP 500. It passes every offline test
// because node:sqlite does not enforce that limit and exposes no API to set one
// (no getCompileOptions / limit setter), so no behavioral test can reproduce
// the failure. The only gate is static: refuse to land a pattern that grows with
// the data. This is the exact shape that 500'd GET /api/attest on 2026-09-18.
//
// WHAT IS SAFE (not flagged):
//   - `LIKE ?`  — a `?` bound by the client; the caller controls the length.
//   - `LIKE 'prefix%'` — a fully static literal; no value is assembled.
//   - `instr(col, ?) > 0` — no LIKE at all; no pattern.
//
// WHAT IS FLAGGED (a pattern operand built at runtime):
//   - SQL concatenation with `||` in the pattern operand (the incident).
//   - A `${...}` interpolation in the pattern operand — reported by the caller
//     as the "\u0000" marker (see sqlLiterals in scan-guard.mjs).
//
// GLOB is checked too: it is the same "a pattern built from data" defect, and it
// shares the length bound.
//
// SCOPE: only the pattern operand — the text from the LIKE/GLOB keyword up to
// the next clause keyword. A legitimate `||` or `${...}` elsewhere in the
// statement (e.g. building a sort key, not a pattern) is not implicated.
// A keyword that terminates a LIKE/GLOB pattern operand. If the operand runs past
// one of these, the `||` / `${...}` found there is not part of the pattern.
const CLAUSE =
  /\b(WHERE|AND|OR|GROUP|HAVING|ORDER|LIMIT|OFFSET|UNION|ALL|INTERSECT|EXCEPT|THEN|ELSE|END|ON|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|NATURAL|AS|RETURNING)\b/i;

export function isRuntimeLikePattern(literal) {
  for (const m of literal.matchAll(/\b(LIKE|GLOB)\b/gi)) {
    let tail = literal.slice(m.index + m[0].length);
    const stop = CLAUSE.exec(tail);
    if (stop) tail = tail.slice(0, stop.index);
    if (/\|\|/.test(tail) || tail.includes("\u0000")) return true;
  }
  return false;
}
