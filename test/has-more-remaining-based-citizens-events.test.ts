// has_more on /api/citizens and the paged /api/events view inferred "more
// exist" from page fullness (`returned === CITIZEN_PAGE`,
// `events.length === IDENTITY_LOG_PAGE`). A page that comes back at exactly the
// cap is ambiguous: it is either the last page or the first of several, and the
// row count cannot tell them apart. At an exact multiple the response served
// `has_more: true` together with a continuation cursor whose next page is empty.
//
// This is the class the maintainer fixed twice in about thirty hours on other
// doors, both times by asking the question instead of inferring it:
//   2620ac14 (2026-09-22T02:47:56Z) seals ?checks_of=  -> remaining-count
//   1571ef34 (2026-09-22T03:27:57Z) attestations        -> over-fetch by one
//   #368                            seals listing       -> remaining-count
// listings/payouts/rail-events already over-fetch (LIMIT PAGE + 1,
// test length > PAGE) and are correct at every size.
//
// Killing mutation for each assertion below:
//   citizens: restore `const has_more = returned === CITIZEN_PAGE;`
//   events:   restore `const has_more = events.length === IDENTITY_LOG_PAGE;`
// Each turns the corresponding assertion red at the exact-multiple case while
// leaving every non-multiple case green — which is why no existing test caught
// it: the census fixture is CITIZEN_PAGE + 25 and the events fixtures are not
// sized to the cap.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { citizenDirectory, identityLog, CITIZEN_PAGE, IDENTITY_LOG_PAGE } from "../src/society.ts";

const BASE = 1_780_000_000_000;

async function freshDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { db, env: { DB: new SqliteD1(db) } as never };
}

// A census whose size is an EXACT multiple of the page cap, then walk it.
test("citizens: a census of exactly CITIZEN_PAGE rows reports has_more false", async () => {
  const { db, env } = await freshDb();
  const insert = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  for (let i = 1; i <= CITIZEN_PAGE; i++) insert.run(`c${i}`, BASE + i, BASE + i);

  const page = (await citizenDirectory(env)) as unknown as {
    total: number;
    returned: number;
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page.total, CITIZEN_PAGE, "the fixture is a full census");
  assert.equal(page.returned, CITIZEN_PAGE, "and the page carries all of it");
  assert.equal(
    page.has_more,
    false,
    "at exactly the cap and exhausted there is nothing to continue to; has_more true here hands the caller a cursor whose next page is empty",
  );
  assert.equal(page.next_since, undefined, "and no continuation cursor is offered with it");
});

// The one-over case must still say true — this is what stops the fix from
// being "always false at the boundary".
test("citizens: one row past the cap still reports has_more true", async () => {
  const { db, env } = await freshDb();
  const insert = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  for (let i = 1; i <= CITIZEN_PAGE + 1; i++) insert.run(`c${i}`, BASE + i, BASE + i);

  const page = (await citizenDirectory(env)) as unknown as {
    returned: number;
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page.returned, CITIZEN_PAGE);
  assert.equal(page.has_more, true, "a row remains past this page");
  assert.equal(typeof page.next_since, "number", "so a cursor is offered");
});

// The same boundary on the ascending events view.
test("events: exactly IDENTITY_LOG_PAGE matching rows reports has_more false", async () => {
  const { db, env } = await freshDb();
  const c = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  c.run("mod", BASE, BASE);
  const e = db.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, ?, ?, ?, NULL, ?)",
  );
  for (let i = 1; i <= IDENTITY_LOG_PAGE; i++) e.run("moderation", `row ${i}`, BASE + i, `h${i}`);

  const page = (await identityLog(env, "moderation", 0)) as unknown as {
    count: number;
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page.count, IDENTITY_LOG_PAGE, "the fixture fills the page exactly");
  assert.equal(
    page.has_more,
    false,
    "the log held exactly this many rows; has_more true here makes a complete walk look truncated",
  );
  assert.equal(page.next_since, undefined, "and hands back no cursor");
});

// The same boundary reached through the ?since= arm — this is the branch a
// WALKER uses, and it is a separate SQL statement from page one. Without this,
// a fix applied to one arm and not the other stays green: the fixture below is
// 2 * CITIZEN_PAGE rows so page two lands exactly on the cap.
test("citizens: the ?since= arm also stops at exactly the cap", async () => {
  const { db, env } = await freshDb();
  const insert = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  for (let i = 1; i <= CITIZEN_PAGE * 2; i++) insert.run(`c${i}`, BASE + i, BASE + i);

  const page1 = (await citizenDirectory(env)) as unknown as {
    returned: number;
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page1.returned, CITIZEN_PAGE);
  assert.equal(page1.has_more, true, "two pages of census: page one has more");
  assert.equal(typeof page1.next_since, "number");

  const page2 = (await citizenDirectory(env, page1.next_since)) as unknown as {
    returned: number;
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page2.returned, CITIZEN_PAGE, "page two is the exact remainder");
  assert.equal(
    page2.has_more,
    false,
    "the census ends exactly on the page cap; has_more true here re-serves an empty page forever",
  );
  assert.equal(page2.next_since, undefined, "and offers no cursor");
});

// The ?since= arm must over-fetch too, and this is the assertion that says so.
// A census of 2*CITIZEN_PAGE rows alone cannot see it: page two is the last
// page, and a truncated fetch of the cap reports the same `false` as the
// correct one. One row past the second page is what separates them.
test("citizens: the ?since= arm over-fetches too, so page two still sees a third page", async () => {
  const { db, env } = await freshDb();
  const insert = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  for (let i = 1; i <= CITIZEN_PAGE * 2 + 1; i++) insert.run(`c${i}`, BASE + i, BASE + i);

  const page1 = (await citizenDirectory(env)) as unknown as {
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page1.has_more, true);
  const page2 = (await citizenDirectory(env, page1.next_since)) as unknown as {
    returned: number;
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page2.returned, CITIZEN_PAGE, "page two is a full page");
  assert.equal(
    page2.has_more,
    true,
    "one row remains past page two; a page-two fetch capped at CITIZEN_PAGE cannot know that and reports false",
  );
  assert.equal(typeof page2.next_since, "number", "so a third page's cursor is offered");

  const page3 = (await citizenDirectory(env, page2.next_since)) as unknown as {
    returned: number;
    has_more: boolean;
  };
  assert.equal(page3.returned, 1, "and the walk terminates on the real last page");
  assert.equal(page3.has_more, false);
});

test("events: one row past the cap still reports has_more true", async () => {
  const { db, env } = await freshDb();
  const c = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  c.run("mod", BASE, BASE);
  const e = db.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, ?, ?, ?, NULL, ?)",
  );
  for (let i = 1; i <= IDENTITY_LOG_PAGE + 1; i++) e.run("moderation", `row ${i}`, BASE + i, `h${i}`);

  const page = (await identityLog(env, "moderation", 0)) as unknown as {
    count: number;
    has_more: boolean;
    next_since?: number;
  };
  assert.equal(page.count, IDENTITY_LOG_PAGE);
  assert.equal(page.has_more, true, "a row remains past this page");
  assert.equal(typeof page.next_since, "number", "so a cursor is offered");
});
