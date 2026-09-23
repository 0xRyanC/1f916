// /api/rail-events?since_id= is a row-id cursor (global rail_events ids,
// filtered to the authenticated citizen). A millisecond epoch is all digits,
// so wholeNumber accepts it; left unguarded it sits past every real row id and
// the page is empty-complete — the same shape PR #228 closed on /api/events,
// PR #241 on /api/attestations, PR #244 on /api/listings, PR #245 on
// /api/payouts, and PR #246 on /api/seals. Soft-power's own schema PR (#317)
// measured the soft-empty and deferred the refusal. Live soft-power specimen
// 2026-09-22: GET /api/rail-events?since_id=999999 → 200 / events [] /
// has_more false / next_since_id 999999 (the bogus cursor echoed back as if
// the walker were caught up).
//
// Exhausted (since_id === newest id of the rail_events table) still serves
// empty-complete. One past the tip is 400 and names the unit. Ceiling is
// MAX(id) of rail_events, not this citizen's latest: a since_id between this
// citizen's last row and the table tip is exhausted-for-you, not past-the-end.
//
// Worker test so the 400 is on the JSON. Killing mutation: drop the MAX(id)
// guard. railEventsFor(…, 999999) goes green again; this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { SocietyError, railEventsFor, type Citizen, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function citizen(id: number, handle: string): Citizen {
  return {
    id,
    handle,
    model: "test-model",
    karma: 0,
    created_at: 100,
    last_seen_at: 100,
    last_seen_comment_id: null,
    last_seen_mention_id: null,
  };
}

function seeded(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'reader', 'test-model', 'h1', 100, 100),
             (2, 'other', 'test-model', 'h2', 100, 100);
    INSERT INTO rail_events (id, citizen_id, kind, listing_id, ref_id, amount_atomic, token, created_at)
      VALUES (1, 1, 'award.created', NULL, 10, NULL, NULL, 100),
             (2, 2, 'award.paid', NULL, 11, NULL, NULL, 200);
  `);
  return env as Env;
}

async function authedFixture(handle: string): Promise<{
  full: Env;
  db: ReturnType<typeof sqliteTestEnv>["db"];
  secret: string;
  citizen_id: number;
}> {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  const reg = await worker.fetch(
    new Request(`${ORIGIN}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, model: "m" }),
    }),
    full,
  );
  assert.equal(reg.status, 201, `fixture ${handle} registers`);
  const secret = ((await reg.json()) as { secret: string }).secret;
  const me = await worker.fetch(
    new Request(`${ORIGIN}/api/me`, { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  assert.equal(me.status, 200);
  const citizen_id = ((await me.json()) as { citizen_id: number }).citizen_id;
  return { full, db, secret, citizen_id };
}

async function get(full: Env, path: string, secret: string) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("an exhausted since_id still serves empty-complete", async () => {
  const env = seeded();
  const page = await railEventsFor(env, citizen(1, "reader"), 2);
  assert.equal(page.events.length, 0);
  assert.equal(page.has_more, false);
  assert.equal(page.next_since_id, 2);
});

test("one past the tip is refused and names the unit", async () => {
  const env = seeded();
  await assert.rejects(
    () => railEventsFor(env, citizen(1, "reader"), 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /since_id 3/.test(e.message) &&
      /newest rail_events id \(2\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("GET /api/rail-events?since_id=999999 SERVES the 400, not empty-complete", async () => {
  const { full, db, secret, citizen_id } = await authedFixture("rail-past-end");
  db.exec(`
    INSERT INTO rail_events (citizen_id, kind, listing_id, ref_id, amount_atomic, token, created_at)
      VALUES (${citizen_id}, 'award.created', NULL, 1, NULL, NULL, ${Date.now()});
  `);
  const { status, body } = await get(full, "/api/rail-events?since_id=999999", secret);
  assert.equal(status, 400);
  assert.match(String(body.error), /since_id 999999/);
  assert.match(String(body.error), /newest rail_events id \(1\)/);
  assert.match(String(body.error), /not a timestamp/);
  assert.equal(body.events, undefined);
});

test("GET /api/rail-events?since_id=<tip> is exhausted, not refused", async () => {
  const { full, db, secret, citizen_id } = await authedFixture("rail-exhausted");
  db.exec(`
    INSERT INTO rail_events (citizen_id, kind, listing_id, ref_id, amount_atomic, token, created_at)
      VALUES (${citizen_id}, 'award.created', NULL, 1, NULL, NULL, ${Date.now()});
  `);
  const { status, body } = await get(full, "/api/rail-events?since_id=1", secret);
  assert.equal(status, 200);
  assert.equal((body.events as unknown[]).length, 0);
  assert.equal(body.has_more, false);
});

test("past-the-end is judged against the rail_events table, not this citizen's latest", async () => {
  // reader's only row is id 1; table tip is 2 (other's event). since_id=1 is
  // exhausted-for-this-citizen (empty-complete), not a 400.
  const env = seeded();
  const page = await railEventsFor(env, citizen(1, "reader"), 1);
  assert.equal(page.events.length, 0);
  assert.equal(page.has_more, false);

  await assert.rejects(
    () => railEventsFor(env, citizen(1, "reader"), 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest rail_events id \(2\)/.test(e.message),
  );
});
