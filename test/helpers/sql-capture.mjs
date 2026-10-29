// Records every SQL statement the APPLICATION prepares during `npm test`, so
// test/helpers/scan-guard.mjs can ask SQLite how each one would run.
//
// Why this exists. On 2026-09-17 the D1 meter read ~7 billion rows a day for a
// society of 66k comments. The cost was not a few bad queries but a habit:
// reads that answer by walking a whole table (an inbox found by scanning every
// comment, counts recomputed from scratch on every call). A read shaped like
// that costs rows in proportion to the TABLE, not to what it returns, so it gets
// more expensive every day the society grows and multiplies with traffic. The
// guard makes that shape visible and stops a new one from landing.
//
// Only statements prepared from src/ are recorded. Tests also prepare SQL of
// their own (fixtures, and real COUNT(*)s they compare answers against), and
// those are allowed to scan: they are the reference, not the product. The origin
// is read off the call stack at prepare time. Every adapter here (sqlite-d1.ts
// and the per-file LocalD1/HookedD1 wrappers) prepares synchronously inside the
// .all()/.first()/.run()/.batch() call that src/ makes, so the src/ frame is on
// the stack when prepare runs.
//
// Patched on the prototype, so it reaches every DatabaseSync any test builds,
// however it imports node:sqlite. A no-op unless SQL_CAPTURE_DIR is set.
//
// KILLING MUTATION: make this file a no-op (return before the patch). The guard
// then sees zero statements and refuses, rather than passing on an empty set:
// see MIN_STATEMENTS in scan-guard.mjs.
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";

const dir = process.env.SQL_CAPTURE_DIR;
if (dir) {
  const require_ = createRequire(import.meta.url);
  const { DatabaseSync } = require_("node:sqlite");
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${process.pid}.jsonl`;
  const recorded = new Set();
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function prepare(sql) {
    if (typeof sql === "string" && !recorded.has(sql)) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = limit;
      if (/\/src\/[^\s):]+\.ts/.test(stack)) {
        recorded.add(sql);
        appendFileSync(file, JSON.stringify(sql) + "\n");
      }
    }
    return original.call(this, sql);
  };
}
