// ?named_days= on GET /api/me and named_days on the MCP `me` tool (2026-09-17).
// The owner's condition when the naming estimate's default moved to one day:
// "it should be very simple if somebody wants longer". So the parameter must be
// accepted where a citizen actually calls it, in both cursor modes, and refuse
// a malformed value loudly rather than silently falling back to the default.
//
// Killing mutations: drop "named_days" from QUERY_PARAMS["/api/me"] -> the HTTP
// acceptance assertions go red (400 unknown parameter); make parseNamedDays
// return null on bad input -> the refusal assertions go red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { parseNamedDays, type Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

async function citizenEnv() {
  const { env } = sqliteTestEnv(SCHEMA);
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  const reg = await worker.fetch(new Request("http://t/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "named-reader", model: "m" }) }), full);
  assert.equal(reg.status, 201);
  return { env: full, secret: ((await reg.json()) as { secret: string }).secret };
}
const get = (env: Env, secret: string, qs: string) =>
  worker.fetch(new Request(`http://t/api/me${qs}`, { headers: { Authorization: `Bearer ${secret}` } }), env);

test("GET /api/me accepts named_days in both cursor modes and serves the lookback it applied", async () => {
  const { env, secret } = await citizenEnv();
  for (const [qs, want] of [["", 1], ["?named_days=30", 30], ["?named_days=all", "all"], ["?cursor_mode=id&named_days=7", 7]] as const) {
    const res = await get(env, secret, qs);
    assert.equal(res.status, 200, `${qs || "(none)"} must be accepted`);
    const body = (await res.json()) as { since_last_visit: { named_in_window: { lookback_days: unknown } } };
    assert.equal(body.since_last_visit.named_in_window.lookback_days, want, `${qs || "(none)"} serves its lookback`);
  }
});

test("a malformed named_days is refused, never silently defaulted", async () => {
  const { env, secret } = await citizenEnv();
  for (const bad of ["0", "-3", "3651", "7.5", "week", ""]) {
    const res = await get(env, secret, `?named_days=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, `named_days=${JSON.stringify(bad)} must be refused`);
    await res.body?.cancel();
  }
  assert.equal(parseNamedDays(null), null);
  assert.equal(parseNamedDays(undefined), null);
  assert.equal(parseNamedDays(14), 14);
  assert.equal(parseNamedDays("all"), "all");
  assert.throws(() => parseNamedDays("nope"));
});
