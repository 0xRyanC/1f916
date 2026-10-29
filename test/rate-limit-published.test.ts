// The published rate limit block, checked offline.
//
// Nothing in this repository enforces the limit: it is a Cloudflare rate
// limiting rule on the zone, and officialFacts.rate_limit is a copy of its
// numbers. test/live/rate-limit.test.ts trips the real rule, but the live lane
// runs with continue-on-error, so without this file a typo in the published
// block ships green (found by the pre-deploy auditor, 2026-09-17).
//
// What this can check is internal consistency and that the words match what the
// code does; what it cannot check is the rule itself.
//
// Killing mutations: change per_minute_equivalent alone -> the arithmetic goes
// red; make any route here answer a rate-limit 429 from src/ -> the
// "no 429 from here" assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");

async function official() {
  const { env } = sqliteTestEnv(SCHEMA);
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  const res = await worker.fetch(new Request("http://t/api/official"), full);
  return (await res.json()) as {
    rate_limit: {
      requests: number; period_seconds: number; per_minute_equivalent: number; mitigation_seconds: number;
      applies_to: string; counted_by: string; over_the_limit: string; note: string;
    };
  };
}

test("the published numbers are internally consistent", async () => {
  const r = (await official()).rate_limit;
  for (const [name, value] of Object.entries({ requests: r.requests, period: r.period_seconds, mitigation: r.mitigation_seconds })) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} is a positive whole number`);
  }
  assert.equal(r.per_minute_equivalent, Math.round((r.requests * 60) / r.period_seconds), "the per-minute figure is the same rule");
  assert.ok(r.period_seconds === 10 || r.period_seconds === 60, "Cloudflare counts over 10 or 60 seconds");
});

test("the published words match what this code does", async () => {
  const r = (await official()).rate_limit;
  // Both MCP doors are under the /mcp prefix the rule counts (src/index.ts).
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /path === "\/mcp" \|\| path === "\/mcp\/read"/, "both MCP doors exist");
  assert.match(r.applies_to, /\/api\//);
  assert.match(r.applies_to, /\/mcp\/read/, "the published text must name the read door, not just /mcp");
  // It is an edge rule, so the refusal is Cloudflare's page and the request
  // never reaches this code.
  assert.match(r.over_the_limit, /edge/);
  assert.match(r.over_the_limit, /1015/);
  assert.match(r.counted_by, /IP address/);
  assert.match(r.counted_by, /no exemption/i, "no exemption is possible on this plan, including for the maintainer");
  // The comment beside the block must say the numbers are a copy, or the next
  // reader will look for enforcement in this repository and find none.
  assert.match(source, /THE NUMBERS BELOW ARE A COPY/, "the source says where enforcement actually lives");
});

test("no route in this Worker answers its own rate-limit 429", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  for (const path of ["/api/official", "/api/pulse", "/api/front", "/"]) {
    for (let i = 0; i < 12; i++) {
      const res = await worker.fetch(new Request(`http://t${path}`), full);
      assert.notEqual(res.status, 429, `${path} must not be rate-limited by this code`);
      await res.body?.cancel();
    }
  }
  assert.doesNotMatch(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /rateLimited/, "the Worker-side limiter is gone");
});
