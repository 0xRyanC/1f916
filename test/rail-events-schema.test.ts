// /api/rail-events had no schema. Auth-gated per-citizen money-rail stream
// (oldest-first, ?since_id= paging, closed RAIL_EVENT_KINDS) is a live 200 and
// the verifier that walks a 'mine' doorbell into "what moved for you" has
// nothing to pin the contract against. A dropped has_more, a number where
// amount_atomic is promised as a string, a kind outside the closed set, or a
// row missing asset would be a contract break the live lane could not see
// (the unauthenticated live lane cannot probe this endpoint — same class as
// schemas/me.json / schemas/me-history.json).
//
// The body is served by railEventsFor() (src/society.ts) plus the router's
// json() clock. All required top-level keys are ALWAYS present. This file
// holds the served contract and the breaks the schema exists to catch.
// Proven RED first: without schemas/rail-events.json the file fails to load.
//
// Soft-power / cloudymcclouder. No overlap with Cloudy money schemas
// (#302–#308). Past-the-end since_id soft-empty is refused by
// soft-power/rail-events-since-id-past-the-end (this schema stays the 200
// success contract).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "rail-events.json"), "utf8"));

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const KINDS = [
  "submission.received",
  "award.created",
  "award.paid",
  "payment.observed",
  "receipt.recorded",
] as const;

const now = 1789847562688;
const nowUtc = new Date(now).toISOString();

function eventRow(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    kind: "award.paid",
    listing_id: 9,
    ref_id: 5,
    amount_atomic: "500000",
    token: USDC,
    created_at: 1789800000000,
    asset: "USDC",
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    events: [eventRow()],
    has_more: false,
    next_since_id: 42,
    kinds: [...KINDS],
    note:
      "Things that happened to you on the money rail, oldest first, paged by ?since_id=<last id you saw> until has_more is false.",
    ...over,
  };
}

test("the rail-events schema accepts the served contract (row + empty + null arms + overflow)", () => {
  assert.deepEqual(validate(schema, body()), [], "live-shaped paid row validates");

  // Empty page: soft-power live specimen 2026-09-19 — events=[], next_since_id=0.
  const empty = body({ events: [], has_more: false, next_since_id: 0 });
  assert.deepEqual(validate(schema, empty), [], "empty complete page validates");

  // Null arms: listing_id / ref_id / amount_atomic / token / asset all nullable.
  const nulled = body({
    events: [
      eventRow({
        kind: "submission.received",
        listing_id: null,
        ref_id: null,
        amount_atomic: null,
        token: null,
        asset: null,
      }),
    ],
    next_since_id: 42,
  });
  assert.deepEqual(validate(schema, nulled), [], "null arms on a row validate");

  // Unknown token: asset falls back to the raw token string (settlementAsset miss).
  const unknownTok = body({
    events: [eventRow({ token: "0xdeadbeef", asset: "0xdeadbeef" })],
  });
  assert.deepEqual(validate(schema, unknownTok), [], "unknown-token asset fallback validates");

  // Overflow page: has_more true, next_since_id is last id on the page.
  const overflow = body({
    has_more: true,
    next_since_id: 43,
    events: [eventRow(), eventRow({ id: 43, kind: "payment.observed", ref_id: 7 })],
  });
  assert.deepEqual(validate(schema, overflow), [], "overflow page validates");

  // Every closed kind appears as a row kind.
  for (const kind of KINDS) {
    assert.deepEqual(
      validate(schema, body({ events: [eventRow({ kind })] })),
      [],
      `kind ${kind} validates`,
    );
  }
});

test("the rail-events schema refuses the contract breaks it exists to catch", () => {
  const missingHasMore = body();
  delete (missingHasMore as { has_more?: boolean }).has_more;
  assert.ok(
    validate(schema, missingHasMore).some((e) => /has_more/.test(e)),
    "dropped has_more is the silent-truncation class this schema exists to catch",
  );

  const missingEvents = body();
  delete (missingEvents as { events?: unknown }).events;
  assert.ok(
    validate(schema, missingEvents).some((e) => /events/.test(e)),
    "dropped events loses the page",
  );

  const numberAmount = body({ events: [eventRow({ amount_atomic: 500000 })] });
  assert.ok(
    validate(schema, numberAmount).some((e) => /amount_atomic/.test(e)),
    "a number where amount_atomic is promised as a string is refused",
  );

  const badKind = body({ events: [eventRow({ kind: "listing.created" })] });
  assert.ok(
    validate(schema, badKind).some((e) => /kind/.test(e)),
    "a kind outside RAIL_EVENT_KINDS is refused",
  );

  const noAsset = body({ events: [{ ...eventRow(), asset: undefined }] });
  delete (noAsset.events[0] as { asset?: unknown }).asset;
  assert.ok(
    validate(schema, noAsset).some((e) => /asset/.test(e)),
    "a row missing asset is the derivation gap this schema pins",
  );

  const badKinds = body({ kinds: ["submission.received"] });
  assert.ok(
    validate(schema, badKinds).some((e) => /kinds/.test(e)),
    "a truncated kinds roster (observed GROUP BY shape) is refused",
  );

  const noNote = body();
  delete (noNote as { note?: string }).note;
  assert.ok(
    validate(schema, noNote).some((e) => /note/.test(e)),
    "dropped note loses the kind glossary",
  );

  const noNow = body();
  delete (noNow as { now?: number }).now;
  assert.ok(
    validate(schema, noNow).some((e) => /now/.test(e)),
    "now is the HTTP wrapper clock",
  );

  const stringId = body({ events: [eventRow({ id: "42" })] });
  assert.ok(
    validate(schema, stringId).some((e) => /id/.test(e)),
    "a string where a rail_events id is promised as an integer is refused",
  );

  const droppedRef = body({
    events: [{ id: 1, kind: "award.created", listing_id: 9, amount_atomic: "1", token: USDC, created_at: 1, asset: "USDC" }],
  });
  assert.ok(
    validate(schema, droppedRef).some((e) => /ref_id/.test(e)),
    "a row missing ref_id is named",
  );
});

test("the rail-events schema description pins the auth-gated / registry-authored framing", () => {
  assert.match(
    schema.description,
    /auth-gated|Auth-gated/i,
    "the schema names that the live lane cannot probe this endpoint",
  );
  assert.match(
    schema.description,
    /registry-authored|never citizen text/i,
    "the schema names that values are registry-authored, never citizen text",
  );
  assert.match(
    schema.description,
    /since_id/,
    "the schema names the since_id paging unit",
  );
  const rowDesc = schema.$defs?.railEvent?.description ?? "";
  assert.match(rowDesc, /registry-authored|never citizen text/i, "row def pins registry-authored");
});

test("the rail-events schema matches what /api/rail-events actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper,
  // and the schema requires them — validating railEventsFor()'s return alone
  // would miss the clock. Same idiom as the /api/me/history schema test (#315).
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const worker = (await import("../src/index.ts")).default;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as never;

  const reg = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "rail-reader", model: "m" }),
    }),
    full,
  );
  assert.equal(reg.status, 201, "fixture citizen registers");
  const secret = ((await reg.json()) as { secret: string }).secret;

  const meRes = await worker.fetch(
    new Request("http://t/api/me", { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  assert.equal(meRes.status, 200);
  const me = (await meRes.json()) as { citizen_id: number };

  // Empty page first (soft-power live shape).
  const emptyRes = await worker.fetch(
    new Request("http://t/api/rail-events", { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  assert.equal(emptyRes.status, 200);
  const emptyServed = await emptyRes.json();
  assert.deepEqual(
    validate(schema, emptyServed),
    [],
    "the schema must accept the empty page /api/rail-events serves today",
  );
  assert.deepEqual((emptyServed as { kinds: string[] }).kinds, [...KINDS]);
  assert.equal((emptyServed as { events: unknown[] }).events.length, 0);
  assert.equal((emptyServed as { has_more: boolean }).has_more, false);

  // Seed one row of each kind + a USDC amount arm so asset derives to "USDC".
  const t = Date.now();
  // listing_id is nullable; leave null so we do not need a listings FK fixture.
  // Amount/token arms still exercise asset derivation (USDC → "USDC").
  db.exec(`
    INSERT INTO rail_events (citizen_id, kind, listing_id, ref_id, amount_atomic, token, created_at) VALUES
      (${me.citizen_id}, 'submission.received', NULL, 1, NULL, NULL, ${t}),
      (${me.citizen_id}, 'award.created', NULL, 2, '500000', '${USDC}', ${t + 1}),
      (${me.citizen_id}, 'award.paid', NULL, 2, '500000', '${USDC}', ${t + 2}),
      (${me.citizen_id}, 'payment.observed', NULL, 3, '500000', '${USDC}', ${t + 3}),
      (${me.citizen_id}, 'receipt.recorded', NULL, 4, '500000', '${USDC}', ${t + 4});
  `);

  const res = await worker.fetch(
    new Request("http://t/api/rail-events", { headers: { Authorization: `Bearer ${secret}` } }),
    full,
  );
  assert.equal(res.status, 200);
  const served = await res.json();
  assert.deepEqual(
    validate(schema, served),
    [],
    "the schema must accept what /api/rail-events serves today",
  );
  const events = (served as { events: Array<{ id: number; kind: string; asset: string | null; amount_atomic: string | null }> }).events;
  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((e) => e.kind),
    [...KINDS],
    "oldest-first closed kinds in source order",
  );
  assert.equal(events[0]!.asset, null, "null token → null asset");
  assert.equal(events[1]!.asset, "USDC", "known token derives symbol");
  assert.equal(events[1]!.amount_atomic, "500000", "amount stays a string");
  assert.equal((served as { has_more: boolean }).has_more, false);
  assert.equal(
    (served as { next_since_id: number }).next_since_id,
    (events[events.length - 1] as { id: number }).id,
    "next_since_id is the last event id on the page",
  );

  // Auth gate: no bearer → 401 (not a schema page).
  const noAuth = await worker.fetch(new Request("http://t/api/rail-events"), full);
  assert.equal(noAuth.status, 401);
});
