// The per-client request limit (src/rate-limit.ts), with a fake binding that
// records the keys it is asked about and refuses on demand.
//
// Guarantees, each with the mutation that kills it:
// 1. Over the limit is a 429 with Retry-After and NO database read at all.
//    Killing mutation: move the rateLimited() call below the router -> the
//    zero-statement assertion goes red.
// 2. An authenticated request is counted by a HASH of its token, never by the
//    raw token and never by IP; an anonymous one by IP. Killing mutation: key on
//    the raw token -> red.
// 3. The maintainer is exempt by token hash and by egress address. Killing
//    mutation: drop either exemption -> red.
// 4. Authenticated requests also pass a per-IP backstop. Killing mutation:
//    remove the backstop call -> red.
// 5. The numbers published at /api/official equal the binding configuration in
//    wrangler.jsonc, so the served claim cannot drift from what is enforced.
//    Killing mutation: change one number in either place -> red.
// 6. No binding configured means no limit (tests, local dev).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { RATE_LIMIT, type RateLimiter } from "../src/rate-limit.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fakeLimiter(allow: boolean) {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    async limit({ key }) {
      keys.push(key);
      return { success: allow };
    },
  };
  return { limiter, keys };
}

function envWith(extra: Record<string, unknown>) {
  const { env } = sqliteTestEnv(SCHEMA);
  const inner = (env as unknown as { DB: { prepare(s: string): unknown; batch(s: unknown): unknown } }).DB;
  const sql: string[] = [];
  const DB = { prepare: (s: string) => (sql.push(s), inner.prepare(s)), batch: (s: unknown) => inner.batch(s) };
  return { env: { DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000", ...extra } as unknown as Env, sql };
}

const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`http://t${path}`, { method, headers: { "CF-Connecting-IP": "203.0.113.9", ...headers } });

test("over the limit is a 429 with Retry-After, and nothing reads the database", async () => {
  const { limiter } = fakeLimiter(false);
  const { env, sql } = envWith({ RATE_LIMITER: limiter });
  const res = await worker.fetch(req("/api/stats"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), String(RATE_LIMIT.period_seconds));
  const body = (await res.json()) as { counted_by: string; limit: number };
  assert.equal(body.counted_by, "ip_address");
  assert.equal(body.limit, RATE_LIMIT.requests);
  assert.deepEqual(sql, [], "a limited request must not touch D1");
});

test("anonymous requests are counted by IP, authenticated ones by a hash of the token", async () => {
  const { limiter, keys } = fakeLimiter(true);
  const { env } = envWith({ RATE_LIMITER: limiter });
  await (await worker.fetch(req("/api/official"), env)).body?.cancel();
  const token = "1f916_sk_example_token_value";
  await (await worker.fetch(req("/api/official", { Authorization: `Bearer ${token}` }), env)).body?.cancel();
  const hash = createHash("sha256").update(token).digest("hex");
  assert.deepEqual(keys, ["ip:203.0.113.9", `t:${hash.slice(0, 32)}`]);
  assert.ok(!keys.some((k) => k.includes(token)), "the raw token is never a key");
});

test("the maintainer is exempt by token hash and by egress address", async () => {
  const token = "1f916_sk_maintainer_example";
  const hash = createHash("sha256").update(token).digest("hex");
  const byToken = fakeLimiter(false);
  const a = envWith({ RATE_LIMITER: byToken.limiter, MAINTAINER_SECRET_SHA256: hash });
  const r1 = await worker.fetch(req("/api/official", { Authorization: `Bearer ${token}` }), a.env);
  assert.notEqual(r1.status, 429, "the maintainer's token is never limited");
  await r1.body?.cancel();
  assert.deepEqual(byToken.keys, [], "and the limiter is not even consulted");

  const byIp = fakeLimiter(false);
  const b = envWith({ RATE_LIMITER: byIp.limiter, RATE_LIMIT_EXEMPT_IPS: "198.51.100.1, 203.0.113.9" });
  const r2 = await worker.fetch(req("/api/official"), b.env);
  assert.notEqual(r2.status, 429, "an exempt egress address is never limited");
  await r2.body?.cancel();
  assert.deepEqual(byIp.keys, []);
});

test("authenticated requests also pass a per-IP backstop, so made-up tokens cannot multiply the allowance", async () => {
  const main = fakeLimiter(true);
  const backstop = fakeLimiter(false);
  const { env, sql } = envWith({ RATE_LIMITER: main.limiter, RATE_LIMITER_IP_BACKSTOP: backstop.limiter });
  const res = await worker.fetch(req("/api/official", { Authorization: "Bearer made-up-token-1" }), env);
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as { counted_by: string }).counted_by, "ip_address");
  assert.deepEqual(backstop.keys, ["ip:203.0.113.9"]);
  assert.deepEqual(sql, []);
});

test("CORS preflight and an unconfigured deployment are not limited", async () => {
  const { limiter, keys } = fakeLimiter(false);
  const { env } = envWith({ RATE_LIMITER: limiter });
  const pre = await worker.fetch(req("/mcp", {}, "OPTIONS"), env);
  assert.notEqual(pre.status, 429);
  assert.deepEqual(keys, [], "a preflight is not counted");
  const { env: bare } = envWith({});
  const res = await worker.fetch(req("/api/official"), bare);
  assert.equal(res.status, 200);
  await res.body?.cancel();
});

test("the limit published at /api/official is the limit the Worker is configured with", async () => {
  const { env } = envWith({});
  const official = (await (await worker.fetch(req("/api/official"), env)).json()) as {
    rate_limit: { requests: number; period_seconds: number; per_ip_backstop_for_authenticated_requests: number };
  };
  const jsonc = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(jsonc) as { ratelimits: { name: string; simple: { limit: number; period: number } }[] };
  const main = config.ratelimits.find((r) => r.name === "RATE_LIMITER")!;
  const backstop = config.ratelimits.find((r) => r.name === "RATE_LIMITER_IP_BACKSTOP")!;
  assert.equal(official.rate_limit.requests, main.simple.limit);
  assert.equal(official.rate_limit.period_seconds, main.simple.period);
  assert.equal(official.rate_limit.per_ip_backstop_for_authenticated_requests, backstop.simple.limit);
  assert.equal(backstop.simple.period, main.simple.period);
});
