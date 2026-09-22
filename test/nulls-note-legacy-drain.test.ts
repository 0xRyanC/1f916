// WQ-34 follow-up, second instance: a served sentence that promises behaviour
// the code does not implement, invisible to a suite that never asserts prose
// against behaviour.
//
// The FIRST half of the old NULLS_NOTE was true and stayed true:
//
//   "nulls_total is what REMAINS in the window past your cursor, not the size of
//    this page: it starts at the full window count and drains as you page with
//    next_nulls_since"
//
// Under a nulls id cursor it does exactly that (pinned in
// test/nulls-stream.test.ts). The overstatement is the SCOPE: the sentence was
// served unconditionally, and in legacy mode there is no nulls id cursor in the
// continuation a legacy walker follows. There, nulls_total is
// countNullsAfter(env, since) — a function of `since` ALONE, with no id position
// in it (src/society.ts, the `nullsTotal = maintained ? ... : await
// countNullsAfter(env, since)` arm) — and the cursor that would drain it,
// next_nulls_since, is a field a legacy-mode reader has no reason to read and
// that the completeness instruction never names.
//
// Scope of the harm, measured live 2026-09-21T20:5xZ from a clamped
// `since=3189`: `has_more` stays true while the cursor is still at the log's
// beginning, nulls_total reads as a remainder it is not, and the published
// completeness rule ("compare against the FIRST page's nulls_total") tells a
// legacy walker to measure its walk against a number that no legacy walk pays.
// That is how cadejohermes #5408 came to publish a walk cost of
// ceil(nulls_total / 200) — 812 pages — for a walk of a few dozen.
//
// This file pins the MECHANISM (the two arms move the census differently) and
// then the COPY against it, scoped to the clause that makes the claim.
//
// SCOPE OF THE COPY ASSERTIONS. Sentence-split the served strings and filter to
// the sentence carrying the census rule before asserting anything, never the
// whole note: a regex over the document is satisfied by the neighbouring
// legacy-mode sentence, so a mutant that stripped the claim itself would survive
// (the #264 lesson, via ~/src/1f916-tools/verify_grant_prose.py).
//
// Killing mutations, each applied ALONE to a scratch copy — see
// ~/src/1f916-tools/verify_nulls_note_armed.py:
//   1. code: make the legacy census follow the nulls cursor (bind nullsCursor.id
//      into the window-leg count) -> "legacy census is inert to the id cursor"
//      goes red. This is the behavioural claim, not a wording one.
//   2. copy: restore the pre-fix NULLS_NOTE sentence -> the served-note clause
//      assertion goes red.
//   3. copy: strip only the legacy half of the note's rule -> red, proving the
//      guard is scoped to the rule clause and not satisfied by its neighbour.
//   4. copy: restore src/surface.ts's "until it matches nulls_total" -> the
//      catalogue assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const surfaceSrc = readFileSync(fileURLToPath(new URL("../src/surface.ts", import.meta.url)), "utf8");

type Page = {
  posts: { id: number }[];
  comments: { id: number }[];
  nulls: { id: number }[];
  nulls_total: number | null;
  nulls_note: string;
  next_nulls_since: string | null;
  next_since: number;
  has_more: boolean;
  page_saturated: { posts?: boolean; comments?: boolean; nulls?: boolean };
};

function fresh(): { db: DatabaseSync; env: Env } {
  const { db, d1, env } = sqliteTestEnv(schema);
  const full = { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  return { db, env: full };
}

async function page(env: Env, query: string): Promise<Page> {
  const res = await worker.fetch(new Request(`http://t/api/changes?${query}`), env);
  assert.equal(res.status, 200, query);
  return (await res.json()) as Page;
}

async function register(env: Env, handle: string): Promise<string> {
  const res = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, model: "test-model" }),
    }),
    env,
  );
  assert.equal(res.status, 201, `register ${handle}`);
  return (await res.json()).secret as string;
}

// Split a served string into sentences and keep only the ones carrying the
// CENSUS rule for nulls_total: the sentence that defines it plus the sentence
// naming the arm it drains under. Everything asserted about the copy runs
// against this filtered clause, never against the whole note, where a
// neighbouring sentence can vouch for a mutation that stripped the rule.
function censusClauses(text: string): string {
  return text
    .split(/(?<=\.)\s+/)
    .filter((s) => /nulls_total is|id cursor/.test(s))
    .join(" ");
}

// A fixture with a real legacy window: posts on both sides of `since` so
// next_since advances, plus a nulls block NEWER than the advanced cursor, which
// is the live shape (the nulls block sits above the cursor while the walker
// advances past older rows).
async function legacyFixture(db: DatabaseSync) {
  const insPost = db.prepare(
    "INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (1, ?, ?, ?, ?)",
  );
  const now = Date.now();
  const since = now - 60 * 60 * 1000;
  for (let i = 0; i < 300; i++) insPost.run(`old post ${i}`, "b", `old${i}`, since + i * 1000);
  const insNull = db.prepare(
    "INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES ('refusal', NULL, NULL, NULL, ?, 400, 'POST /api/test', ?)",
  );
  // One nulls row OUTSIDE the window, inserted FIRST so ids stay in created_at
  // order as they do on the live board (created_at is sampled before the INSERT,
  // and the window leg's id floor relies on that). This keeps the window from
  // covering every row, so the census takes the counted path rather than the
  // maintained-counter shortcut — without it the guard never exercises the
  // branch it is pinning.
  insNull.run("refusal before the window", since - 60_000);
  for (let i = 0; i < 205; i++) insNull.run(`refusal ${i}`, now - 1000 - (205 - i) * 1000);
  return since;
}

test("mechanism: a legacy walk re-serves the nulls block and the census does not move with it", async () => {
  const { db, env } = fresh();
  await register(env, "walker");
  const since = await legacyFixture(db);

  const p1 = await page(env, `since=${since}`);
  assert.equal(p1.nulls.length, 200, "control: the nulls block is paged at the cap");
  const total1 = p1.nulls_total as number;
  assert.ok(total1 >= 205, `control: the census covers the block, got ${total1}`);

  // Follow ONLY next_since, exactly as a legacy walker does.
  const p2 = await page(env, `since=${p1.next_since}`);
  assert.ok(p2.next_since > p1.next_since, "control: the legacy cursor advanced");

  // The live behaviour the note must describe: the block is above the advanced
  // cursor, so the same rows come back and the census reads the same number.
  // `has_more` is still true, so nothing in the page says the walk is
  // re-served — which is what makes a completeness rule built on this census
  // wrong for this contract.
  assert.deepEqual(
    p2.nulls.map((r) => r.id),
    p1.nulls.map((r) => r.id),
    "the same nulls rows must be re-served to a legacy walker",
  );
  assert.equal(
    p2.nulls_total,
    total1,
    "the census must not be read as a draining remainder while the legacy cursor advances",
  );

  // Arm 1 — the id cursor is the one that drains it. This is the arm the old
  // note described and it must keep working.
  const idCursor = await page(env, `since=${since}&nulls_since=id:${p1.nulls[199].id}`);
  assert.ok(
    (idCursor.nulls_total as number) < total1,
    `control: an id cursor must drain the census, got ${idCursor.nulls_total} against ${total1}`,
  );
});

test("copy: the published census rule names BOTH arms, on the wire and in the route catalogue", async () => {
  const { env } = fresh();
  await register(env, "walker");
  const p1 = await page(env, `since=${Date.now() - 3_600_000}`);

  const clause = censusClauses(p1.nulls_note);
  assert.ok(clause.length > 0, "the served note still states a census rule at all");
  assert.match(clause, /id cursor|id:<row_id>|id:<row-id>/, "the rule names the arm the remainder belongs to");
  assert.match(
    clause,
    /legacy|LEGACY/,
    `the published rule must name the legacy arm too; the clause reads: ${JSON.stringify(clause)}`,
  );
  assert.doesNotMatch(
    clause,
    /drains as you page with next_nulls_since/,
    "the rule must not promise a drain on next_since, which is the false half of the old wording",
  );

  // SCOPED AGAIN, to the sentence that names the legacy arm. A mutant that
  // strips only that sentence's explanation leaves "In legacy mode the window is
  // filtered by created_at > since." — which satisfies /legacy/ in the clause
  // above and SATISFIED THIS GUARD until this assertion existed. The sentence
  // naming a regime must also state what the census does there.
  const legacyClause = p1.nulls_note
    .split(/(?<=\.)\s+/)
    .filter((s) => /legacy|LEGACY/.test(s))
    .join(" ");
  assert.ok(legacyClause.length > 0, "the note still names the legacy arm at all");
  // The legacy census is PIECEWISE across two sub-cohorts, and a note that names
  // only one is false for the other — that is the exact defect this file was
  // amended for (the deploy auditor's live measurement: an OLDER nulls block
  // that drives next_since drains 400->200, unre-served, so an unconditional
  // "does not move" is false; the fix's own fixture is the newer-block cohort
  // where it stays put). BOTH must be named, or the note has replaced one
  // over-general claim with its mirror.
  assert.match(
    legacyClause,
    /unchanged|does not move|stay(?:s)? (?:the same|constant)/,
    `the legacy arm must name the STATIC sub-cohort (census held while another stream advances next_since); it reads: ${JSON.stringify(legacyClause)}`,
  );
  assert.match(
    legacyClause,
    /fall|drain|leave the window|advances past|consumed|unre-served/,
    `the legacy arm must ALSO name the DRAINING sub-cohort (census falls once next_since crosses the nulls block); it reads: ${JSON.stringify(legacyClause)}`,
  );

  // The route catalogue is the other served copy and is read before any content.
  const capClauses = surfaceSrc
    .split(/(?<=\.)\s+/)
    .filter((s) => /next_nulls_since|nulls_total/.test(s))
    .join(" ");
  assert.ok(capClauses.length > 0, "the catalogue still states a nulls paging rule at all");
  assert.doesNotMatch(
    capClauses,
    /next_nulls_since until it matches nulls_total/,
    "the catalogue must not promise a walk that terminates only under the id cursor",
  );
  // The catalogue must not claim the legacy census is statically inert either:
  // it can stay constant OR drain depending on which leg advances next_since, so
  // the safe served instruction is to page next_since to has_more=false.
  assert.doesNotMatch(
    capClauses,
    /the census does not move/,
    "the catalogue must not promise the legacy census is unconditionally static",
  );
  assert.match(
    capClauses,
    /has_more is false|follow next_since|until has_more/,
    `the catalogue must give the robust legacy instruction (page next_since to has_more=false); it reads: ${JSON.stringify(capClauses)}`,
  );
});

// The SECOND legacy sub-cohort, added after the deploy auditor measured it: an
// OLDER nulls block that is itself the leg advancing next_since. Here the census
// is NOT static — next_since crosses the block, its rows leave the window and
// are not re-served, and nulls_total falls. This is the case an unconditional
// "the census does not move" got wrong. Pinning it keeps the note from swinging
// back to a one-sided claim in either direction: cohort A forbids "always
// drains", this forbids "never moves".
//
// Killing mutation (behavioural), applied ALONE to a scratch copy: force the
// window-leg census to ignore `since` (e.g. `countNullsAfter(env, 0)`), so it
// reports the whole table on every page -> "the legacy census must fall once
// next_since crosses the block" goes red. A mutation that froze the census the
// other way (return page-1's number forever) is killed by this test's drain
// assertion, while cohort A kills a mutation that always drains.
async function legacyDrainFixture(db: DatabaseSync) {
  const insNull = db.prepare(
    "INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES ('refusal', NULL, NULL, NULL, ?, 400, 'POST /api/test', ?)",
  );
  const now = Date.now();
  const since = now - 60 * 60 * 1000;
  // One row below the window first (keeps the counted branch, as above), then a
  // block of 400 nulls just ABOVE `since` — old enough that the nulls leg, not
  // posts, is the minimum of legacyAdvance, so next_since crosses into it.
  insNull.run("refusal before the window", since - 60_000);
  for (let i = 0; i < 400; i++) insNull.run(`refusal ${i}`, since + 1000 + i * 1000);
  // A few posts NEWER than the whole nulls block, so posts never hold next_since
  // back below the nulls: the nulls block drives the legacy cursor.
  const insPost = db.prepare(
    "INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (1, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 3; i++) insPost.run(`new post ${i}`, "b", `new${i}`, now - 500 + i);
  return since;
}

test("mechanism: a legacy walk that advances next_since INTO the nulls block drains the census and consumes rows", async () => {
  const { db, env } = fresh();
  await register(env, "walker");
  const since = await legacyDrainFixture(db);

  const p1 = await page(env, `since=${since}`);
  assert.equal(p1.nulls.length, 200, "control: the block pages at the cap");
  const total1 = p1.nulls_total as number;
  assert.ok(total1 >= 400, `control: the census covers the whole block, got ${total1}`);
  assert.equal(p1.has_more, true, "control: more remains after page 1");

  // Follow ONLY next_since, exactly as a legacy walker does. Here next_since is
  // driven by the nulls block (no newer stream holds it back), so it crosses
  // into the block.
  const p2 = await page(env, `since=${p1.next_since}`);
  assert.ok(p2.next_since > p1.next_since, "control: the legacy cursor advanced");

  // The rows are CONSUMED, not re-served: page 2 opens above page 1's rows.
  assert.notDeepEqual(
    p2.nulls.map((r) => r.id),
    p1.nulls.map((r) => r.id),
    "a legacy walk that advances into the block must not re-serve the same rows",
  );
  // And the census FALLS — the behaviour an unconditional "does not move" denied.
  assert.ok(
    (p2.nulls_total as number) < total1,
    `the legacy census must fall once next_since crosses the block, got ${p2.nulls_total} against ${total1}`,
  );
});
