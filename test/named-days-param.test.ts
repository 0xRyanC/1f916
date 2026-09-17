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

test("since and named_days together are refused, not silently resolved", async () => {
  // ?since= sets the estimate's window itself, so a named_days beside it used to
  // be computed and discarded: a valid value silently ignored, and in the one
  // direction this change exists to prevent (?since=0&named_days=1 scanned the
  // whole history). Found by the pre-deploy auditor, 2026-09-17.
  // Killing mutation: drop the check in src/index.ts -> this goes red.
  const { env, secret } = await citizenEnv();
  const res = await get(env, secret, "?since=0&named_days=1");
  assert.equal(res.status, 400, "the combination must be refused");
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /named_days/);
  assert.match(body.error, /since/);
  // Each alone still works.
  for (const qs of ["?since=0", "?named_days=1"]) {
    const ok = await get(env, secret, qs);
    assert.equal(ok.status, 200, `${qs} alone must still be served`);
    await ok.body?.cancel();
  }
});

test("the MCP me tool refuses since and named_days together too, and serves named_days alone", async () => {
  // The HTTP door's guard was tested; the MCP door's copy was not, and deleting
  // it left the whole suite green (pre-deploy auditor, round 2). Agents reach
  // /api/me through both doors, so both need the same refusal.
  // Killing mutation: delete the since/named_days check in src/mcp.ts -> the
  // first half goes red (isError undefined, a 200 that quietly drops named_days).
  const { env, secret } = await citizenEnv();
  const call = async (args: Record<string, unknown>) => {
    const res = await worker.fetch(
      new Request("http://t/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "me", arguments: args } }),
      }),
      env,
    );
    return (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  };

  const refused = await call({ since: 0, named_days: 1 });
  assert.equal(refused.result?.isError, true, "the MCP door must refuse the combination");
  const text = refused.result?.content?.[0]?.text ?? "";
  assert.match(text, /named_days/);
  assert.match(text, /since/);

  // And the parameter alone works through the same door, with the lookback served.
  const ok = await call({ named_days: 30 });
  assert.equal(ok.result?.isError, undefined, "named_days alone must be served");
  const body = JSON.parse(ok.result?.content?.[0]?.text ?? "{}") as {
    since_last_visit?: { named_in_window?: { lookback_days?: unknown } };
  };
  assert.equal(body.since_last_visit?.named_in_window?.lookback_days, 30);
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
