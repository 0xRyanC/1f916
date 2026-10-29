// nulls_total in CURSOR mode (`nulls_since=id:<n>`), after the 2026-09-17 change
// that stopped it reading the whole table.
//
// WHY THIS FILE EXISTS SEPARATELY. Migrations 0051 and 0056 fixed the windowed
// branch of the nulls census and left the cursor branch alone, and the cursor
// branch is the one the lossless walk uses — patrol-read.py and any citizen
// paging with nulls_since=id:N. Measured against production 2026-09-17:
//
//   SELECT COUNT(*) FROM nulls WHERE created_at > 0 AND id > 1   191,434 rows
//   the page query beside it                                          51 rows
//
// The existing nulls-census-cost.test.ts guards pass without touching one line
// of this: every one of them calls changes() with nulls_since unset, so the
// cursor branch is never entered. A fixture that cannot reach the code it is
// pointed at is not a weak test, it is an absent one.
//
// PROVING WHICH PATH RAN NEEDS A SPY, NOT AN ASSERTION ON THE NUMBER, and that
// is worth stating plainly. The fast path is EXACTLY equal to the real count
// whenever its premises hold — that is the whole point of it — so no value
// assertion can distinguish them, and a test that only checked the total would
// stay green with the fix reverted. So the prepared SQL is recorded and the
// guard is "no COUNT(*) over nulls was ever prepared".
//
// Six guarantees, each with the mutation that kills it:
//
// 1. PREMISE. The fixture actually reaches the fast path: ids gapless from 1,
//    counter agreeing, cursor strictly inside the table, since below the floor.
//    Killing mutation: seed a gap and this goes red before any cost assertion
//    can pass vacuously.
// 2. Below the floor, the cursor census prepares NO COUNT(*) over nulls.
//    Killing mutation: restore the unconditional
//    `SELECT COUNT(*) FROM nulls WHERE created_at > ?1 AND id > ?2` — red.
// 3. It is still exact, at every cursor position including both ends.
//    Killing mutation: `maxId - cursor + 1`, or dropping the Math.min clamp — red.
// 4. A GAP IN THE IDS refuses the fast path and counts for real. This is the
//    failure that would look healthy: nothing errors, the census is just too
//    big forever. Killing mutation: drop the `maxId === counter` check — red.
// 5. A windowed `since` still counts for real. The arithmetic is only valid when
//    the created_at predicate excludes nothing.
//    Killing mutation: drop the cursorCoversEveryRow check — red.
// 6. A missing counter row falls back to a real count and NEVER to zero — the
//    unscoped zero that would read as "this society refused nothing".
//    Killing mutation: default the counter to maxId, or `?? 0` the total — red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// Rows are stamped well above 0 so that since=0 sits strictly below the floor,
// which is the regime the lossless walk actually uses.
const FLOOR = 1_000_000;

// Wraps the env so every prepared statement is recorded. The fast path and the
// real count agree by construction, so this is the only way to see which ran.
function spied(count: number) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let i = 0; i < count; i++) {
    db.exec(`INSERT INTO nulls (kind, reason, created_at) VALUES ('refusal', 'r${i}', ${FLOOR + i * 10})`);
  }
  const sql: string[] = [];
  const inner = (env as unknown as { DB: { prepare(s: string): unknown } }).DB;
  const spy = {
    prepare(statement: string) {
      sql.push(statement);
      return inner.prepare(statement);
    },
  };
  return { env: { DB: spy } as unknown as Env, db, sql };
}

// Every COUNT(*) against nulls, however it is spelled, excluding the bucket and
// counter reads which are one row each by design.
const countsOverNulls = (sql: string[]) =>
  sql.filter((s) => /COUNT\(\*\)/i.test(s) && /\bFROM nulls\b/i.test(s) && !/nulls_buckets/i.test(s));

const census = async (env: Env, since: number, cursor: number) =>
  (await changes(env, since, null, null, `id:${cursor}`)) as { nulls_total: number; nulls: Array<{ id: number }> };

const realCount = (db: DatabaseSync, since: number, cursor: number) =>
  Number(
    (db.prepare("SELECT COUNT(*) AS n FROM nulls WHERE created_at > ? AND id > ?").get(since, cursor) as { n: number }).n,
  );

test("the fixture reaches the fast path: gapless ids from 1, counter agreeing, cursor inside the table", () => {
  const { db } = spied(40);
  const edge = db
    .prepare(
      `SELECT (SELECT MIN(id) FROM nulls) AS min_id,
              (SELECT MAX(id) FROM nulls) AS max_id,
              (SELECT MIN(created_at) FROM nulls) AS floor,
              (SELECT n FROM table_counts WHERE name = 'nulls') AS counter_n`,
    )
    .get() as { min_id: number; max_id: number; floor: number; counter_n: number };
  assert.equal(edge.min_id, 1, "the arithmetic is based at id 1");
  assert.equal(edge.max_id, edge.counter_n, "gapless: max id and the maintained counter must agree");
  assert.ok(edge.floor > 0, "since=0 must sit strictly below the floor, or the covered regime is never entered");
  assert.equal(edge.max_id, 40, "the cursor probes below assume 40 rows");
});

test("below the floor, the cursor census reads the table's edges and never counts it", async () => {
  const { env, db, sql } = spied(40);
  const out = await census(env, 0, 10);
  assert.equal(out.nulls_total, realCount(db, 0, 10), "the cheap answer must still be the true one");
  assert.deepEqual(
    countsOverNulls(sql),
    [],
    `the cursor branch must not count the table below the floor; it prepared:\n  ${countsOverNulls(sql).join("\n  ")}`,
  );
});

test("the cursor census is exact at every position, including both ends", async () => {
  const { env, db } = spied(40);
  const mismatches: string[] = [];
  for (const cursor of [0, 1, 2, 19, 20, 39, 40, 41, 999]) {
    const got = (await census(env, 0, cursor)).nulls_total;
    const want = realCount(db, 0, cursor);
    if (got !== want) mismatches.push(`cursor=${cursor} got=${got} want=${want}`);
  }
  assert.deepEqual(mismatches, [], `cursor census disagreed with a real count:\n  ${mismatches.join("\n  ")}`);
  // Or "no mismatches" is the agreement of two zeros.
  assert.ok((await census(env, 0, 10)).nulls_total > 0, "the probes must cover a non-empty remainder");
});

test("a gap in the ids refuses the arithmetic and counts for real", async () => {
  const { env, db, sql } = spied(40);
  // A deleted row is the shape that breaks the premise: the counter's trigger
  // decrements but MAX(id) does not move, so max and counter disagree. Nothing
  // deletes a null today; this guards the day something does.
  db.exec("DELETE FROM nulls WHERE id = 7");
  const out = await census(env, 0, 10);
  assert.equal(out.nulls_total, realCount(db, 0, 10), "a gap must not inflate the census");
  assert.ok(countsOverNulls(sql).length > 0, "a broken premise must fall back to counting for real");
});

test("a windowed since still counts for real, because the arithmetic is only valid when created_at excludes nothing", async () => {
  const { env, db, sql } = spied(40);
  const since = FLOOR + 195;
  const out = await census(env, since, 10);
  assert.equal(out.nulls_total, realCount(db, since, 10), "inside the window the answer is not maxId - cursor");
  assert.ok(countsOverNulls(sql).length > 0, "a windowed since must not take the edge arithmetic");
});

test("a missing counter row falls back to a real count and never to zero", async () => {
  const { env, db, sql } = spied(40);
  db.exec("DELETE FROM table_counts WHERE name = 'nulls'");
  const out = await census(env, 0, 10);
  assert.equal(out.nulls_total, 30, "no counter must mean count for real");
  assert.notEqual(out.nulls_total, 0, "a served 0 here would claim the society refused nothing past this cursor");
  assert.ok(countsOverNulls(sql).length > 0, "the fallback is a real count, not a cheaper guess");
});
