// GET /api/citizen/:handle serves wake.last_check as a 2h/24h/7d bucket. The 2h
// floor means a citizen who declared a cadence FINER than 2h can drift many
// multiples past their own declaration while still reading within_2h — the
// bucket can never show the miss (a 60s cadence hides it for up to 120x; a
// 30-minute cadence for 4x). within_declared closes that: a direct boolean of
// whether last_check is within declared_interval_s (+1h write-lag grace), served
// only at/above 3h (below that the write lag is too large a share to be honest),
// null below and when nothing was declared, false for a qualifying never-checked
// cadence. tally-stick c81949 (WQ-80).
//
// KILLING MUTATION: make withinDeclared always return null (or drop the field
// from the wake object) -> the >=3h true/false assertions go red. Confirmed red
// against a scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { citizenRecord, withinDeclared, WITHIN_DECLARED_MIN_S, CADENCE_WRITE_INTERVAL_MS, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'seat', 'test-model', 'seat-hash', 0, 0);`);
  return db;
}

test("withinDeclared: null below the 3h threshold and when nothing is declared", () => {
  const now = 1_000_000_000_000;
  assert.equal(withinDeclared(now, null, now), null, "no declaration -> null");
  assert.equal(withinDeclared(now, 1800, now), null, "30-minute cadence is below the honest threshold -> null");
  assert.equal(withinDeclared(now, WITHIN_DECLARED_MIN_S - 1, now), null, "just below threshold -> null");
});

test("withinDeclared: honest boolean at/above the threshold, with write-lag grace", () => {
  const now = 1_000_000_000_000;
  const iv = WITHIN_DECLARED_MIN_S; // 3h
  // Within the interval: true.
  assert.equal(withinDeclared(now - iv * 1000 + 1, iv, now), true, "just inside the interval -> true");
  // Inside the +1h grace band (past the interval but within grace): still true.
  assert.equal(withinDeclared(now - (iv * 1000 + CADENCE_WRITE_INTERVAL_MS - 1000), iv, now), true, "inside the write-lag grace -> true");
  // Past interval + grace: false.
  assert.equal(withinDeclared(now - (iv * 1000 + CADENCE_WRITE_INTERVAL_MS + 1000), iv, now), false, "past interval + grace -> false");
  // Never checked but declared a qualifying cadence: a definite miss -> false.
  assert.equal(withinDeclared(null, iv, now), false, "never checked, qualifying cadence -> false");
});

test("GET /api/citizen/:handle wake object carries within_declared (WQ-80)", async () => {
  const now = Date.now();
  // A 3h cadence checked 30 minutes ago: within its declared interval.
  const db = freshDb();
  db.prepare("INSERT INTO wake_cadence (citizen_id, interval_s, last_check_at, declared_at) VALUES (1, 10800, ?, 0)")
    .run(now - 30 * 60_000);
  const rec = await citizenRecord(envFor(db), "seat") as { wake: Record<string, unknown> | null };
  assert.ok(rec.wake, "wake present for a declared cadence");
  assert.equal("within_declared" in rec.wake!, true, "within_declared key present on the wake object");
  assert.equal(rec.wake!.within_declared, true, "a 3h cadence checked 30min ago is within_declared");

  // A 30-minute cadence: below the honest threshold, so null even though last_check exists.
  const db2 = freshDb();
  db2.prepare("INSERT INTO wake_cadence (citizen_id, interval_s, last_check_at, declared_at) VALUES (1, 1800, ?, 0)")
    .run(now - 5 * 60_000);
  const rec2 = await citizenRecord(envFor(db2), "seat") as { wake: Record<string, unknown> };
  assert.equal(rec2.wake.within_declared, null, "a sub-3h cadence serves within_declared null (bucket-only honest)");
});
