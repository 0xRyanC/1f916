// WQ-48 (follow-up to PR #331 by cloudymcclouder, issue #263): PR #331 gave
// readTreasuryAssets an internal deadline and threaded it through the Base
// batches, but the production call to readBnbHoldings omitted it, so the
// BNB-chain read was bounded only by the caller's outer race. On a degraded
// BNB-RPC window the composite could still hang past the budget the way #331
// fixed for Base. The fix passes the same deadline to readBnbHoldings.
//
// What this pins: with a healthy Base window and a hanging BNB provider, the
// composite settles at the internal deadline (not the full 3s-per-hop x 3-pass
// BNB walk), serves the Base lines that landed, and the unread BNB line names
// itself so the totals go incomplete rather than a partial being served whole.
//
// Killing mutation: drop `deadline` from the readBnbHoldings call at its
// production call site in src/assets.ts and the elapsed-time assertion below
// goes red -- the BNB read runs its full unbounded walk (~9s) instead of
// settling at the ~400ms deadline.

import test from "node:test";
import assert from "node:assert/strict";
import { SELECTORS, readTreasuryAssets, summarizeAssets, type RpcCall } from "../src/assets.ts";

const TREASURY = "0x0000000000000000000000000000000000000038";
const abiWord = (value: bigint) => value.toString(16).padStart(64, "0");
const abi = (...values: bigint[]) => "0x" + values.map(abiWord).join("");
const Q96 = 1n << 96n;

type RpcRequest = { id: number; params: [RpcCall, "latest"] };

// Base answers every call in one pass (no holes -> no re-request passes), so the
// Base walk consumes almost none of the internal deadline and leaves it intact
// for the BNB read that runs after it. collectFees is 0, so there is no pool
// depth walk.
function fullBaseRows(payload: RpcRequest[]) {
  return payload.map(({ id, params }) => {
    const call = params[0];
    let result: string;
    if (call.data === SELECTORS.latestRoundData) result = abi(1n, 2_000n * 100_000_000n, 0n, 1_700_000_000n, 1n);
    else if (call.data.startsWith(SELECTORS.getSlot0)) result = abi(Q96, 0n, 0n, 3_000n);
    else if (call.data.startsWith(SELECTORS.collectFees)) result = abi(0n, 0n);
    else if (call.data.startsWith(SELECTORS.balanceOf)) result = abi(2_000_000n);
    else result = abi(0n);
    return { id, result };
  });
}

async function withMockFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  action: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("the BNB read shares the internal deadline: a hanging BNB provider is bounded, not the full unbounded walk", async () => {
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("bnb")) {
      // The BNB provider hangs; only a clamped abort ends it. Unbounded, this is
      // three passes at the 3000ms per-hop default (~9s); deadline-bounded it
      // ends at the ~400ms budget the Base walk left behind.
      return new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    const payload = JSON.parse(String(init?.body)) as RpcRequest[];
    return Response.json(fullBaseRows(payload));
  };

  await withMockFetch(mock, async () => {
    const started = Date.now();
    const read = await readTreasuryAssets(TREASURY, ["https://base.rpc"], ["https://bnb.rpc"], 400);
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < 2_000,
      `the BNB read must settle at the internal deadline, not run its full unbounded walk (took ${elapsed}ms)`,
    );

    // The Base USDC line that answered survives the degraded BNB window.
    const usdc = read.holdings.find((h) => h.asset === "USDC" && h.location === "wallet");
    assert.ok(usdc, "the answered Base USDC holding is still served");
    assert.equal(usdc?.value_cents, 200);

    // The unread BNB line names itself, so the totals go incomplete rather than a
    // partial being served as a settled figure (null-discipline preserved).
    assert.match(read.errors.join("\n"), /BNB Chain/i, "the unread BNB line is disclosed, not dropped");
    const summary = summarizeAssets(read.holdings, read.errors.length === 0);
    assert.equal(summary.complete, false, "a cut BNB read leaves the composite incomplete");
    assert.equal(summary.total_cents, null, "an incomplete read must not serve a partial total");
  });
});
