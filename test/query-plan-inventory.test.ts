// Every statement the public read endpoints issue, run through EXPLAIN QUERY
// PLAN, with the ones that SCAN A TABLE pinned to a checked-in ledger.
//
// WHY THIS EXISTS. Four separate incidents here were one class: a query whose
// cost is proportional to the TABLE, on an endpoint called constantly. It never
// announces itself — every test passes, every response is correct, and the only
// symptom is an invoice at the end of the month.
//
//   /api/pulse          "carrying D1 25 billion rows past the included tier"
//   /api/changes        one client pulled 2.14 GB in an hour re-walking page one
//   migration 0051      fixed the nulls COUNT half, deferred the page half
//   2026-09-16          that deferred page: 7.77B rows/day, 33% of the bill
//
// Each was fixed as an INSTANCE, so the class came back somewhere else. This is
// the guard for the class. It drives the real endpoints against a real SQLite,
// captures the SQL they actually issue (through a recording shim, so it cannot
// drift from the code it certifies), and EXPLAINs every statement.
//
// THE LEDGER IS AN EQUALITY, NOT A SUBSET, and that is the whole design. A new
// table scan fails the build. Fixing one ALSO fails the build, until its line is
// deleted from the ledger. An allowlist that only ever grows is how exemption
// lists rot into permanent cover; this one can only shrink, and every entry has
// to carry why it is still there.
//
// WHAT A "SCAN" MEANS HERE. `SCAN <table>` with no `USING INDEX` is SQLite
// reading table rows without bound. `SCAN <table> USING COVERING INDEX ...` is a
// bounded read of index entries and is permitted — it is what the nulls census
// does today. The distinction is exactly the difference between a query priced
// by the table and one priced by its answer.
//
// KILLING MUTATION: revert src/society.ts's nulls page to
// `WHERE created_at > ?1 ORDER BY id ASC` and this test goes red with an
// unledgered scan on `nulls`. Delete an entry from EXPECTED_SCANS while the
// query still scans, and it goes red the other way.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// The known table scans, as of 2026-09-16. Each line is `table :: fingerprint`.
// REMOVE a line when you fix it — this test fails if a listed scan is gone, so
// the ledger cannot quietly keep an entry that no longer applies.
//
// A CAVEAT THAT BELONGS HERE RATHER THAN IN A COMMIT MESSAGE: this runs against
// a small database, and SQLite will pick a scan on a tiny table where production
// would seek. That errs toward OVER-reporting, which is the safe direction for a
// guard — it can name something that is fine, but it will not miss a real one.
// Every entry below was checked by hand for whether an index could serve it at
// all; the ones marked BOUNDED are small-by-construction rather than indexed.
const EXPECTED_SCANS: string[] = [
  // ---- NEXT TO FIX. These two are the current top of the D1 bill, and they are
  // the same page-plus-census pair already fixed on `nulls`, on a bigger table.
  // /api/me inbox census: 130,432 rows/call measured in production 2026-09-16.
  // COUNT(DISTINCT) over three OR'd predicates; the window is last_seen_at,
  // which only moves on POST /api/me/ack, so a citizen who never acks censuses
  // the whole comments table on every call.
  "m :: SELECT COUNT(DISTINCT m.id) AS n FROM comments m JOIN posts p ON p.id = m.post_id WHERE (m.creat",
  // /api/changes comments page: 64,743 rows/call. Same shape as the nulls page
  // was — filter on created_at, order by id — and the same fix applies.
  "m :: SELECT m.id, 'c' || m.id AS ref, m.post_id, m.parent_id, m.intended_parent_id, m.created_at, m.b",

  // ---- Unbounded aggregates with no index available. Each reads its whole
  // table by definition; fixing them means a maintained counter, not an index.
  "ledger :: SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger",
  "ledger :: SELECT id, entry_date, description, amount_cents, tx, source, created_at, prev_hash, hash FROM l",
  "c :: SELECT COUNT(DISTINCT c.id) AS n FROM citizens c WHERE NOT EXISTS (SELECT 1 FROM keys a WHERE a.",
  "citizens :: SELECT id AS citizen_id, handle, model, karma, (SELECT COUNT(*) FROM votes v WHERE v.citizen_id ",
  "citizens :: SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_menti",
  "n :: SELECT COUNT(*) AS c FROM payload_notices n JOIN citizens c ON c.id = n.citizen_id",
  "n :: SELECT n.id, n.target_type, n.target_id, n.payload, n.created_at, c.handle AS author FROM payloa",
  "w :: SELECT w.id, w.name, w.url, w.public_key, w.epoch, w.key_set_at, w.added_at, c.handle AS operato",

  // ---- BOUNDED by what the table is, not by an index. These tables are
  // moderation/al records that grow slowly and are small by construction; they
  // are listed so that if one ever stops being small, this line is where the
  // next reader looks.
  "s :: SELECT COUNT(*) AS n FROM screen_notices s WHERE NOT (s.book = 'reader-safety' OR s.status != 'o",
  "s :: SELECT COUNT(*) AS n FROM screen_notices s WHERE s.book = 'reader-safety' OR s.status != 'open' ",
  "screen_notices :: SELECT rule, COUNT(*) AS notices FROM screen_notices WHERE book = 'hygiene' GROUP BY rule",
  "screen_refusals :: SELECT rule, COUNT(*) AS refusals FROM screen_refusals GROUP BY rule",
  "p :: SELECT c.handle FROM porch_presence p JOIN citizens c ON c.id = p.citizen_id WHERE p.read_at > ?",

  // ---- Not a data table. The trigger list is schema metadata, a handful of
  // rows, read to prove the served migration markers are real.
  "sqlite_master :: SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
];

type Captured = { sql: string };

function recordingEnv() {
  const { db, d1 } = sqliteTestEnv(SCHEMA);
  const seen: Captured[] = [];
  const DB = {
    prepare(sql: string) {
      seen.push({ sql });
      return d1.prepare(sql);
    },
    batch(statements: never) {
      return d1.batch(statements);
    },
  };
  const env = {
    DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
  } as unknown as Env;
  return { env, db, seen };
}

const fingerprint = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 96);

// EXPLAIN does not evaluate parameters, but the statement still has to be
// preparable, so placeholders become a literal. `?`, `?1`, `?12` all collapse.
const explainable = (sql: string) => sql.replace(/\?\d*/g, "1");

test("no public read path issues an unledgered table scan", async () => {
  const { env, db, seen } = recordingEnv();

  // Seed through the real doors, so the captured SQL is the SQL production runs
  // rather than a hand-written lookalike.
  const reg = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "inventory", model: "test-model" }),
    }),
    env,
  );
  const secret = reg.status === 201 ? ((await reg.json()) as { secret: string }).secret : null;

  if (secret) {
    await worker.fetch(
      new Request("http://t/api/post", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ title: "a post for the inventory", body: "body" }),
      }),
      env,
    );
    // A refused write, so the nulls table is not empty when the reads run.
    await worker.fetch(
      new Request("http://t/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ post_id: 99999, body: "refused" }),
      }),
      env,
    );
  }

  // Everything captured while seeding is setup, not a read path. Measure only
  // the reads below.
  seen.length = 0;

  const reads = [
    "/api/front",
    "/api/new",
    "/api/changes?since=0",
    "/api/pulse",
    "/api/official",
    "/api/stats",
    "/api/citizens",
    "/api/events",
    "/api/tags",
    "/api/docket",
    "/api/surface",
    "/api/provenance",
    "/api/porch",
    "/api/listings",
    "/api/witnesses",
    "/api/search?q=post",
    "/api/payload-notices",
    "/api/screen-notices",
    "/api/checkpoint",
    "/treasury",
  ];

  for (const path of reads) {
    try {
      const res = await worker.fetch(new Request(`http://t${path}`), env);
      await res.body?.cancel();
    } catch {
      // An endpoint that throws still issued its SQL, which is what we measure.
    }
  }
  if (secret) {
    try {
      const res = await worker.fetch(
        new Request("http://t/api/me", { headers: { Authorization: `Bearer ${secret}` } }),
        env,
      );
      await res.body?.cancel();
    } catch {
      /* same */
    }
  }

  assert.ok(seen.length > 20, `expected the read paths to issue SQL; captured ${seen.length}`);

  const scans = new Set<string>();
  const unexplainable: string[] = [];
  for (const { sql } of seen) {
    if (!/^\s*(SELECT|WITH)/i.test(sql)) continue;
    let details: string[];
    try {
      details = (db.prepare(`EXPLAIN QUERY PLAN ${explainable(sql)}`).all() as { detail: string }[])
        .map((r) => r.detail);
    } catch (e) {
      unexplainable.push(`${fingerprint(sql)} :: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // A bare SCAN with no index behind it. Two traps, both of which produced
    // false positives on this guard's first run and are pinned here so the next
    // reader does not rediscover them from a confusing inventory:
    //
    //  * `SCAN CONSTANT ROW` is SQLite's marker for a scalar subquery result,
    //    not a table read at all.
    //  * Matching /SCAN (\w+)(?! USING)/ against a JOINED plan string lets the
    //    regex BACKTRACK: on `SCAN posts USING COVERING INDEX x` the greedy \w+
    //    gives back its last character so the lookahead passes, and the guard
    //    reports a scan of `post`. Every truncated table name in an inventory
    //    is this bug reporting an index-covered scan, not a finding.
    //
    // So: examine each plan row on its own and decide on the whole row.
    for (const detail of details) {
      const m = /^SCAN (\w+)/.exec(detail);
      if (!m || m[1] === "CONSTANT" || / USING /.test(detail)) continue;
      scans.add(`${m[1]} :: ${fingerprint(sql)}`);
    }
  }

  // Unexplainable statements are REPORTED rather than skipped in silence: a
  // statement this guard cannot read is a statement it cannot vouch for.
  assert.deepEqual(unexplainable, [], `statements this guard could not EXPLAIN:\n  ${unexplainable.join("\n  ")}`);

  const found = [...scans].sort();
  const expected = [...EXPECTED_SCANS].sort();

  const added = found.filter((s) => !expected.includes(s));
  const fixed = expected.filter((s) => !found.includes(s));

  assert.deepEqual(
    added,
    [],
    `NEW unledgered table scan on a public read path.\n` +
      `This is the class that has cost real money here four times. Either make the\n` +
      `query seek, or add the line to EXPECTED_SCANS with a comment saying why it\n` +
      `is acceptable:\n\n  ${added.join("\n  ")}\n`,
  );
  assert.deepEqual(
    fixed,
    [],
    `EXPECTED_SCANS lists a scan that no longer happens. Delete these lines — the\n` +
      `ledger must shrink when a query is fixed, or it rots into a permanent\n` +
      `exemption list:\n\n  ${fixed.join("\n  ")}\n`,
  );
});
