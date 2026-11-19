// Regression coverage for issue #263: a degraded Base-RPC window used to let
// readTreasuryAssets outrun the outer ASSET_REFRESH_BUDGET_MS race, so the
// timeout branch served `holdings: []` even though some lines had already
// landed. The fix is an internal deadline on readTreasuryAssets, threaded
// through batchCall / batchCallComplete: once it lands, the batch stops
// re-requesting and returns what it has, so a slow read settles inside the
// outer budget and hands back its partial book instead of an empty one.
//
// The tests read the behavior against a mocked fetch, never the weather.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_CONTRACTS,
  SELECTORS,
  batchCall,
  readTreasuryAssets,
  summarizeAssets,
  type RpcCall,
} from "../src/assets.ts";

const TREASURY = "0x0000000000000000000000000000000000000038";
const abiWord = (value: bigint) => value.toString(16).padStart(64, "0");
const abi = (...values: bigint[]) => "0x" + values.map(abiWord).join("");

type RpcRequest = {
  id: number;
  params: [RpcCall, "latest"];
};

// The treasury's Base batch answers USDC (row 0, 2,000,000 raw units) and the
// oracle; WETH (row 1) is the hole a rate-limited provider leaves, and the
// fee-manager claim rows are dropped too. That is the partial state a degraded
// window produces, and it is exactly what this read is for.
function partialBaseRows(payload: RpcRequest[]) {
  const Q96 = 1n << 96n;
  return payload.map(({ id, params }, i) => {
    const call = params[0];
    let result: string;
    if (call.data === SELECTORS.latestRoundData) result = abi(1n, 2_000n * 100_000_000n, 0n, 1_700_000_000n, 1n);
    else if (call.data.startsWith(SELECTORS.getSlot0)) result = abi(Q96, 0n, 0n, 3_000n);
    else if (call.data.startsWith(SELECTORS.collectFees)) result = abi(0n, 0n);
    else if (i === 0) result = abi(2_000_000n); // USDC, answers
    else result = "0x"; // everything else is the degraded hole
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

test("readTreasuryAssets serves the landed lines inside the budget instead of an empty book", async () => {
  let calls = 0;
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const payload = JSON.parse(String(init?.body)) as RpcRequest[];
    if (calls === 1) {
      // The first batch lands USDC and the oracle; the rest is the hole.
      return Response.json(partialBaseRows(payload));
    }
    // The re-request passes hang until their clamped abort ends them. Without
    // the internal deadline each would run the full 3000ms per-hop timeout,
    // and the read would outrun the outer ASSET_REFRESH_BUDGET_MS and be
    // served empty.
    return new Promise<Response>((_resolve, reject) => {
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
  };

  await withMockFetch(mock, async () => {
    const started = Date.now();
    // A 400ms internal deadline, comfortably inside the outer 6s budget.
    const read = await readTreasuryAssets(TREASURY, ["https://degraded.rpc"], [], 400);
    const elapsed = Date.now() - started;

    // The first batch lands; the re-request passes hang until clamped. The read
    // settles at the deadline rather than chasing every hole for the full
    // default number of passes at 3s each.
    assert.ok(calls >= 2, `the re-request passes must have started before the deadline (got ${calls} calls)`);
    assert.ok(
      elapsed < 2_000,
      `the read must settle inside the outer budget, not chase holes past it (took ${elapsed}ms)`,
    );

    // The USDC line that landed survives the degraded read — this is the whole
    // point: a slow window yields the lines that did answer, not holdings: [].
    const usdc = read.holdings.find((h) => h.asset === "USDC" && h.location === "wallet");
    assert.ok(usdc, "the answered USDC holding must be served, not dropped with the rest");
    assert.equal(usdc?.value_cents, 200);

    // The unread rows name themselves, so the totals go null rather than a
    // partial sum being served as a settled figure.
    assert.match(read.errors.join("\n"), /WETH balanceOf did not answer/i);
    const summary = summarizeAssets(read.holdings, read.errors.length === 0);
    assert.equal(summary.complete, false, "a cut re-request leaves the read incomplete");
    assert.equal(summary.total_cents, null, "an incomplete read must not serve a partial total");
  });
});

test("a per-hop timeout is clamped to what is left of the deadline", async () => {
  let fetches = 0;
  await withMockFetch(
    async (_input, init) => {
      fetches++;
      // The provider would take its full 6s window; the clamped abort must end
      // the hop at the deadline instead.
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("aborted"));
        const t = setTimeout(resolve, 6_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return Response.json([]);
    },
    async () => {
      const started = Date.now();
      const out = await batchCall(["https://slow.rpc"], [{ to: BASE_CONTRACTS.USDC, data: SELECTORS.balanceOf }], 3_000, Date.now() + 80);
      const elapsed = Date.now() - started;
      assert.deepEqual(out, [null]);
      assert.ok(elapsed < 500, `the clamped hop must abort at the deadline, not run the full 3000ms (took ${elapsed}ms)`);
      assert.ok(fetches >= 1);
    },
  );
});
