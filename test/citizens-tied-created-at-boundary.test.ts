// GET /api/citizens must not drop a registration that shares its millisecond
// with the last row of a page.
//
// citizenDirectory() pages with `WHERE created_at > ? ORDER BY created_at ASC`
// and hands back the last served row's created_at as next_since. When two
// citizens carry the same created_at and a page boundary falls between them,
// the strict `> next_since` on the next page skips the unserved tied row for
// good — on a STATIC census, with nothing being written. The endpoint's own
// note promises "the census never silently truncates a number you might
// divide by", so this is a promise the code has to keep, not disclose.
//
// Reported by Wotuu (issue #463, 2026-09-24). Latent on the live census today
// (no two registrations share a millisecond yet); this fixture forces the tie
// at the page boundary so a full walk either returns every id or drops one.
//
// The fix trims the trailing tied rows off the page so the next page
// re-collects that whole millisecond from below it. Killing mutation: revert
// the trim in citizenDirectory and this walk goes red with the tied row
// missing (see the RED note on the assertion below).

import test from "node:test";
import assert from "node:assert/strict";
import { citizenDirectory, CITIZEN_PAGE } from "../src/society.ts";
import { readFileSync } from "node:fs";

const BASE = 1_780_000_000_000;

// One millisecond that two registrations tie on, placed so the page boundary
// falls exactly between them: row CITIZEN_PAGE (last served) and row
// CITIZEN_PAGE+1 (first unserved, the peek row) both carry TIE.
const TIE = BASE + 5_000_000;

async function tiedCensus() {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const insert = db.prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)");
  // rows 1..CITIZEN_PAGE-1 : distinct, ascending, all below TIE
  for (let i = 1; i <= CITIZEN_PAGE - 1; i++) insert.run(`c${i}`, BASE + i, BASE + i);
  // row CITIZEN_PAGE and row CITIZEN_PAGE+1 : the tie straddling the boundary
  insert.run(`c${CITIZEN_PAGE}`, TIE, TIE);
  insert.run(`c${CITIZEN_PAGE + 1}`, TIE, TIE);
  // two more rows strictly above TIE so page two carries the tied row plus tail
  insert.run(`c${CITIZEN_PAGE + 2}`, TIE + 100, TIE + 100);
  insert.run(`c${CITIZEN_PAGE + 3}`, TIE + 200, TIE + 200);
  const inserted = CITIZEN_PAGE + 3;
  return { env: { DB: new SqliteD1(db) } as never, inserted };
}

test("a full walk of /api/citizens returns every registration when two tie at the page boundary", async () => {
  const { env, inserted } = await tiedCensus();

  const seen = new Set<number>();
  let pages = 0;
  let since: number | undefined = undefined;
  let next: number | undefined;
  do {
    const page = (await (since === undefined ? citizenDirectory(env) : citizenDirectory(env, since))) as unknown as {
      total: number; returned: number; has_more: boolean; next_since?: number;
      citizens: { citizen_id: number; created_at: number }[];
    };
    pages++;
    assert.ok(pages <= 10, "the walk must terminate, not loop on a stuck cursor");
    assert.equal(page.total, inserted, "total is the whole census on every page");
    for (const c of page.citizens) {
      assert.ok(!seen.has(c.citizen_id), `page ${pages} re-served citizen ${c.citizen_id}: the walk must stay disjoint`);
      seen.add(c.citizen_id);
    }
    if (page.has_more) {
      assert.equal(typeof page.next_since, "number", "a continuation cursor is offered while has_more");
      assert.ok(page.next_since! > (since ?? -Infinity), "next_since strictly advances so the walk cannot stall");
    }
    next = page.has_more ? page.next_since : undefined;
    since = next;
  } while (next !== undefined);

  // RED without the trim: page one advances next_since to TIE, page two selects
  // created_at > TIE and never returns the tied row that sat just past the
  // boundary, so `seen.size` is inserted-1 and this equality fails.
  assert.equal(seen.size, inserted, "every registration is served exactly once across the walk");
  for (let id = 1; id <= inserted; id++) {
    assert.ok(seen.has(id), `citizen ${id} must appear in the walk (the tied boundary row is the one that used to vanish)`);
  }
});
