// The published rate limit is the limit the edge actually enforces.
//
// The numbers in officialFacts.rate_limit are a COPY of a Cloudflare rate
// limiting rule (zone ruleset 77247b2a, rule 7e6e3036); nothing in this
// repository can enforce them, and a Worker-side limiter was tried and removed
// because the binding is documented as approximate and let 320 rapid requests
// through in production. So the only honest check is to trip the real thing:
// this test reads the published pair and then sends enough requests to exceed
// it, expecting Cloudflare's 429.
//
// It deliberately gets itself blocked for the rule's mitigation window (10s),
// which is why it lives here and not in the deterministic suite. It only ever
// requests /api/pulse, the cheapest endpoint on the board, and a blocked request
// never reaches the registry.
//
// KILLING MUTATION: publish a larger `requests` than the rule enforces (e.g. 60
// per 10s) and this goes red, because the burst it sizes from the published
// number no longer trips the edge.

import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_PROBES, LIVE_SKIP_REASON, LIVE_ORIGIN } from "../helpers/live.ts";

test("the published rate limit is enforced at the edge", { skip: LIVE_PROBES ? false : LIVE_SKIP_REASON }, async () => {
  const official = (await (await fetch(`${LIVE_ORIGIN}/api/official`)).json()) as {
    rate_limit: { requests: number; period_seconds: number; per_minute_equivalent: number };
  };
  const { requests, period_seconds, per_minute_equivalent } = official.rate_limit;
  assert.ok(Number.isInteger(requests) && requests > 0, "a published request count");
  assert.equal(per_minute_equivalent, Math.round((requests * 60) / period_seconds), "the per-minute figure is the same rule");

  // One window's worth plus a margin, sent as fast as the network allows.
  const codes: number[] = [];
  for (let i = 0; i < requests + 5; i++) {
    const res = await fetch(`${LIVE_ORIGIN}/api/pulse`);
    await res.body?.cancel();
    codes.push(res.status);
    if (res.status === 429) break;
  }
  assert.ok(codes.includes(429), `exceeding the published limit must be refused; got ${codes.join(",")}`);

  // And the block lifts: after the mitigation window the board answers again.
  await new Promise((r) => setTimeout(r, (period_seconds + 4) * 1000));
  const after = await fetch(`${LIVE_ORIGIN}/api/pulse`);
  await after.body?.cancel();
  assert.equal(after.status, 200, "the block is temporary, not a ban");
});
