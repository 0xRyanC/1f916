// The published rate limit is the limit the edge actually enforces.
//
// The numbers in officialFacts.rate_limit are a COPY of a Cloudflare rate
// limiting rule (zone ruleset 77247b2a, rule 7e6e3036); nothing in this
// repository can enforce them, and a Worker-side limiter was tried and removed
// because the binding is documented as approximate and let 320 rapid requests
// through in production. So the only honest check is to trip the real thing.
//
// BOTH HALVES, because one alone is not a drift check (pre-deploy auditor,
// 2026-09-17): a burst sized from the published number trips the edge whether
// the published number is right or too LARGE, so under-publishing is caught only
// by also sending one window's worth MINUS ONE and requiring every answer to be
// 200. Together they pin the published pair from both sides.
//
// Raw fetch on purpose: the live helper paces requests one per second, which can
// never trip a burst limit. It deliberately gets this address blocked for the
// published mitigation window (10s today) and then waits it out, which is why it
// lives here and not in the deterministic suite, and why it asks only for
// /api/pulse, the cheapest endpoint on the board. A blocked request never
// reaches the registry. Other live probes running beside it retry once after
// 11s (test/helpers/live.ts), so they ride out the block.

import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_PROBES, LIVE_SKIP_REASON, LIVE_ORIGIN } from "../helpers/live.ts";

test("the published rate limit is enforced at the edge", { skip: LIVE_PROBES ? false : LIVE_SKIP_REASON }, async () => {
  const official = (await (await fetch(`${LIVE_ORIGIN}/api/official`)).json()) as {
    rate_limit: { requests: number; period_seconds: number; per_minute_equivalent: number; mitigation_seconds: number };
  };
  const { requests, period_seconds, per_minute_equivalent, mitigation_seconds } = official.rate_limit;
  assert.ok(Number.isInteger(requests) && requests > 0, "a published request count");
  assert.ok(Number.isInteger(mitigation_seconds) && mitigation_seconds > 0, "a published mitigation window");
  assert.equal(per_minute_equivalent, Math.round((requests * 60) / period_seconds), "the per-minute figure is the same rule");

  const burst = async (n: number) => {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await fetch(`${LIVE_ORIGIN}/api/pulse`);
      await res.body?.cancel();
      codes.push(res.status);
      if (res.status === 429) break;
    }
    return codes;
  };
  const clear = async () => new Promise((r) => setTimeout(r, (mitigation_seconds + period_seconds + 2) * 1000));

  // UNDER the published limit: every answer must be served. This is the half
  // that catches a published number SMALLER than the rule enforces.
  await clear();
  const under = await burst(requests - 1);
  assert.ok(!under.includes(429), `one window's worth minus one must all be served; got ${under.join(",")}`);

  // OVER it: the edge must refuse. This half catches a published number LARGER
  // than the rule enforces.
  await clear();
  const over = await burst(requests + 5);
  assert.ok(over.includes(429), `exceeding the published limit must be refused; got ${over.join(",")}`);

  // And the block lifts: it is a pause, not a ban.
  await clear();
  const after = await fetch(`${LIVE_ORIGIN}/api/pulse`);
  await after.body?.cancel();
  assert.equal(after.status, 200, "the block is temporary, not a ban");
});
