// Reproduced on live /treasury (2026-09-16): the array's USDC balanceOf reports
// "did not answer" in the same instant the single-object onchain_cents read of
// the SAME balanceOf succeeds, five reads running. The differentiator is the
// JSON-RPC envelope — some Base providers refuse the batch array from this
// Worker's egress while answering the identical eth_call sent as a lone object.
// batchCall and its array retries never reach the object shape, so a hole those
// providers would fill stayed null and /treasury served complete:false.
//
// This exercises the acceptance criterion by simulation: a provider that refuses
// every array POST (the shape batchCall/batchCallComplete send) but answers a
// single-object POST. batchCallComplete must still fill the holes.

import test from "node:test";
import assert from "node:assert/strict";
import { batchCallComplete, type RpcCall } from "../src/assets.ts";

// A provider that refuses the batch-array envelope (non-2xx) but answers the
// same eth_call when it arrives as a lone JSON-RPC object.
function objectOnlyFetch(): { fetch: typeof globalThis.fetch; arrayPosts: number; objectPosts: number } {
  const state = { arrayPosts: 0, objectPosts: 0, fetch: (() => {}) as unknown as typeof globalThis.fetch };
  state.fetch = (async (_url: string, init?: { body?: string }) => {
    const parsed = JSON.parse(init?.body ?? "null");
    if (Array.isArray(parsed)) {
      state.arrayPosts++;
      // The provider throttles the array envelope: non-2xx, no body worth reading.
      return { ok: false, status: 429, json: async () => ({}) };
    }
    state.objectPosts++;
    // A lone object is answered. singleCall hardcodes the JSON-RPC id, so key the
    // echo off the call's own `to` address instead: a fallback that mapped a
    // result to the wrong hole would surface here, not just a filled slot.
    const to = parsed.params[0].to as string;
    return { ok: true, json: async () => ({ result: "0x" + to.slice(-1).padStart(64, "0") }) };
  }) as unknown as typeof globalThis.fetch;
  return state;
}

test("batchCallComplete fills holes via a single-object fallback when the array envelope is refused", async () => {
  const original = globalThis.fetch;
  const stub = objectOnlyFetch();
  globalThis.fetch = stub.fetch;
  try {
    const calls: RpcCall[] = [
      { to: "0xaaaa000000000000000000000000000000000001", data: "0x70a08231" },
      { to: "0xaaaa000000000000000000000000000000000002", data: "0x70a08231" },
      { to: "0xaaaa000000000000000000000000000000000003", data: "0x18160ddd", from: "0xdeadbeef00000000000000000000000000000000" },
    ];
    const out = await batchCallComplete(["https://rpc-a.example", "https://rpc-b.example"], calls);
    // Every slot filled: the array passes all fail (429), and only the
    // single-object fallback can have produced these.
    assert.deepEqual(
      out,
      ["0x" + "0".repeat(63) + "1", "0x" + "0".repeat(63) + "2", "0x" + "0".repeat(63) + "3"],
      "holes must be filled by the single-object fallback, each mapped to its own call; deleting the fallback leaves them null",
    );
    assert.ok(stub.arrayPosts > 0, "the array passes must actually have been attempted (and refused) first");
    assert.equal(stub.objectPosts, 3, "each remaining hole is retried once as a lone object");
  } finally {
    globalThis.fetch = original;
  }
});

test("the fallback preserves a call's from field", async () => {
  // collectFees is simulated from the treasury; a fallback that dropped `from`
  // would send a different call and get a different (or refused) answer.
  const original = globalThis.fetch;
  let sawFrom = false;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const parsed = JSON.parse(init?.body ?? "null");
    if (Array.isArray(parsed)) return { ok: false, status: 429, json: async () => ({}) };
    if (parsed.params?.[0]?.from === "0xdeadbeef00000000000000000000000000000000") sawFrom = true;
    return { ok: true, json: async () => ({ result: "0x" + "0".repeat(64) }) };
  }) as unknown as typeof globalThis.fetch;
  try {
    await batchCallComplete(["https://rpc-a.example"], [
      { to: "0xaaaa000000000000000000000000000000000003", data: "0xdeadbeef", from: "0xdeadbeef00000000000000000000000000000000" },
    ]);
    assert.ok(sawFrom, "the single-object fallback must carry the call's from field");
  } finally {
    globalThis.fetch = original;
  }
});
