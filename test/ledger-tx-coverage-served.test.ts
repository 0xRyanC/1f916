// Issue #126, point 3 (the count the verdict leaves to the reader's hand):
// the ledger chain does not protect tx (it is outside the preimage), so the
// cross-check a reader is told to perform — "check tx against the description"
// — is only as good as the rows it can reach. The verdict's sentence can stay,
// but it must be qualified by a figure a reader can re-derive: the cross-check
// is available on N of M rows, and here is which.
//
// The fix publishes that figure instead of asserting it in prose: a served
// coverage pair on /api/attest, computed from the rows rather than written
// beside them, so it moves when the data moves. This test is the guard that
// goes red when a row like the legacy outflows 14 or 15 lands — sealed, tx
// set, tx NOT in the description — and the number would otherwise be a lie.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attest } from "../src/chain.ts";
import { recordLedger } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const attestSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/attest.json", import.meta.url)), "utf8"),
) as {
  properties: {
    treasury: { required: string[]; properties: Record<string, { type: string }> };
  };
};

const maintainer = { id: 1 } as never;
const TX_A = `0x${"ab".repeat(32)}`;
const TX_B = `0x${"cd".repeat(32)}`;
const TX_C = `0x${"ef".repeat(32)}`;

// Seed one sealed ledger row per case through the real API. Outflows
// (negative cents) skip the income guards, which is exactly what lets a row
// carry a tx whose copy is missing from the chained description — the shape
// of the legacy outflows 14 and 15.
async function seed(env: { DB: never }, description: string, cents: number, tx: string | null) {
  const result = await recordLedger(env, maintainer, description, cents, tx);
  assert.ok(result.receipt, "the row is hash-chained, so it is sealed");
}

test("the served coverage pair counts the rows, and an outflow without its tx in the description is not chain-covered", async () => {
  const { env, db } = sqliteTestEnv(schemaSql);
  try {
    // M = 3 rows carry a tx.
    //   A: sealed, tx in the description       -> covered
    //   B: sealed, tx NOT in the description   -> NOT covered (a row like 14/15)
    //   C: sealed, tx in the description       -> covered
    await seed(env, `payout ${TX_A}`, -500, TX_A);
    await seed(env, `payout without a reference`, -500, TX_B);
    await seed(env, `payout ${TX_C}`, -500, TX_C);

    const report = await attest(env.DB, 0);
    const treasury = report.treasury;

    // The figure is the whole ledger, not the verified page: absolute by
    // construction, exactly like sealed_entries_total.
    assert.equal(treasury.tx_rows_total, 3, "every row that carries a tx is counted, sealed or not");
    // B is the row like 14 or 15: the number must not count it as covered.
    assert.equal(
      treasury.tx_rows_chain_covered,
      2,
      "only rows that are sealed AND name the tx in their description are chain-covered",
    );
    // The sentence and the figure move together: the served note carries the
    // very "N of M" it is qualifying — recomputed from the two served integers,
    // so a note that no longer matches the numbers it names cannot slip through.
    assert.ok(
      treasury.tx_coverage_note.includes(`on ${treasury.tx_rows_chain_covered} of ${treasury.tx_rows_total} rows`),
      "the note qualifies the promise with the same N-of-M the fields serve",
    );
    // A reader can re-derive the figure from the rows instead of trusting the
    // books: the note is the same arithmetic, and it is present to check.
    assert.ok(
      typeof treasury.tx_rows_total === "number" && Number.isInteger(treasury.tx_rows_total),
      "the coverage total is an integer a reader can recompute",
    );
  } finally {
    db.close();
  }
});

test("the coverage pair is absolute, not windowed to the caller's anchor", async () => {
  const { env, db } = sqliteTestEnv(schemaSql);
  try {
    await seed(env, `payout ${TX_A}`, -500, TX_A);
    await seed(env, `payout ${TX_B}`, -500, TX_B);

    const unanchored = await attest(env.DB, 0);
    const anchored = await attest(env.DB, 0, { ledgerFrom: 2 });

    // Both reads see the whole ledger's coverage, whatever the anchor is. A
    // windowed number under a note promising a global one is the defect this
    // field exists to end (sabertooth, #853).
    assert.equal(anchored.treasury.tx_rows_total, unanchored.treasury.tx_rows_total);
    assert.equal(
      anchored.treasury.tx_rows_chain_covered,
      unanchored.treasury.tx_rows_chain_covered,
    );
    assert.equal(anchored.treasury.tx_rows_total, 2);
    assert.equal(anchored.treasury.tx_rows_chain_covered, 2);
  } finally {
    db.close();
  }
});

test("the treasury schema requires the coverage pair and the marker names the newest field", () => {
  const treasury = attestSchema.properties.treasury;
  for (const field of ["tx_rows_total", "tx_rows_chain_covered"]) {
    assert.ok(
      treasury.required.includes(field),
      `${field} is required: a missing coverage figure is a broken contract, not a quiet null`,
    );
    assert.equal(treasury.properties[field].type, "integer", `${field} is an integer, not prose`);
  }
  // The deterministic marker must name the newest required field this contract
  // adds, or the live probe passes against a deployment that predates it.
  const endpoints = readFileSync(fileURLToPath(new URL("../test/helpers/schema-endpoints.ts", import.meta.url)), "utf8");
  assert.ok(
    endpoints.includes("treasury.tx_rows_chain_covered"),
    "the /api/attest marker names the newest required field, so the probe stages until this deploys",
  );
});
