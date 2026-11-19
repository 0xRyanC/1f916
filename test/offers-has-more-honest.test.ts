// GET /api/offers was LIMIT 200 with no count/total/has_more — a clipped page
// was byte-identical to a whole one. Cloudy #302's schema documented the gap
// ("no total served, so a clipped page is byte-identical to a whole one and
// no has_more exists to omit") and deferred the repair. Soft-power closes it
// the same way tags / witnesses / listing-detail did: name OFFER_PAGE, COUNT
// the matching set, serve count/total/has_more. has_more false only when this
// page holds every matching row.
//
// Killing mutations: drop has_more (schema + this file), hardcode LIMIT 199,
// or compute has_more from page fullness alone.
//
// Soft-power / cloudymcclouder. Not a twin of gooseberry client work.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { OFFER_PAGE, listOffers, type Env } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TERMS = "t".repeat(40);

function seeded(n: number): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const nowS = Math.floor(Date.now() / 1000);
  const future = nowS + 3600 * 24 * 30;
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'seller', 'test-model', 'h1', 100, 100);
  `);
  for (let i = 1; i <= n; i++) {
    db.prepare(
      `INSERT INTO offers (
         id, citizen_id, title, terms, amount_atomic, chain_id, token,
         delivery_window_seconds, expiry, payload_hash, commit_nonce, created_at
       ) VALUES (?, 1, ?, ?, '1000000', 8453, ?, 86400, ?, ?, ?, ?)`,
    ).run(
      i,
      `Offer title ${i}`,
      TERMS,
      TOKEN,
      future + i, // distinct expiry so open-order is stable
      `ph-${i}`.padEnd(64, "a").slice(0, 64),
      `cn-${i}`,
      100 + i,
    );
  }
  return env as Env;
}

test("OFFER_PAGE is 200 and SURFACE cites it for /api/offers", () => {
  assert.equal(OFFER_PAGE, 200);
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/offers");
  assert.ok(route?.caps, "/api/offers carries caps");
  assert.equal(route!.caps!.per_response, OFFER_PAGE);
  assert.match(route!.caps!.more, /has_more/);
});

test("under the cap: has_more false and count equals total", async () => {
  const env = seeded(3);
  const page = await listOffers(env, false);
  assert.equal(page.count, 3);
  assert.equal(page.total, 3);
  assert.equal(page.has_more, false);
  assert.equal(page.offers.length, 3);
});

test("OFFER_PAGE+1 open offers: has_more true, page length = cap, total = n", async () => {
  const n = OFFER_PAGE + 1;
  const env = seeded(n);
  const page = await listOffers(env, false);
  assert.equal(page.count, OFFER_PAGE);
  assert.equal(page.total, n);
  assert.equal(page.has_more, true);
  assert.equal(page.offers.length, OFFER_PAGE);
});

test("GET /api/offers SERVES count/total/has_more (not silent truncation)", async () => {
  const env = seeded(2);
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  const res = await worker.fetch(new Request(`${ORIGIN}/api/offers`), full);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.count, 2);
  assert.equal(body.total, 2);
  assert.equal(body.has_more, false);
  assert.equal((body.offers as unknown[]).length, 2);
});

test("killing mutation: listOffers LIMITs by OFFER_PAGE, not a bare literal", () => {
  const society = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  assert.match(society, /export const OFFER_PAGE = 200/);
  assert.match(society, /LIMIT \$\{OFFER_PAGE\}/);
  assert.match(society, /has_more: page\.length < total/);
});
