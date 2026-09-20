# Fix: /treasury partial-read — internal deadline on readTreasuryAssets (#263)

## The bug

`GET /treasury`'s asset composite races `readTreasuryAssets` against a fixed
`ASSET_REFRESH_BUDGET_MS` (6 s) in `society.ts`. On a degraded Base-RPC window
— public providers rate-limiting Cloudflare Workers egress — the read's own
`batchCallComplete` re-request passes each run the full 3 s per-hop timeout,
and the ~40-call depth walk stacks on top. The read outruns the 6 s budget and
the outer timeout branch serves `holdings: []`, even though some lines (e.g.
the BNB balance) already landed.

Live reproduction, 2026-09-20: 3 rapid reads of `/treasury` returned
`holdings=6, complete=false` twice and `holdings=0, complete=false` once —
the timeout branch is still firing.

## The fix

Give `readTreasuryAssets` its own internal deadline (`TREASURY_ASSET_DEADLINE_MS`
= 5 s), set inside the outer 6 s race, threaded through `batchCall` →
`batchCallComplete` → `readPoolDepth` → `readBnbHoldings`. Once the deadline
lands:

- `batchCallComplete` stops re-requesting holes and returns the partial array
  (holes stay null, never zero);
- `batchCall` clamps the per-hop timeout to the remaining budget and abandons
  untried providers;
- the depth walk degrades to "no realizable figure" the same way a failed walk
  does.

The read settles inside the outer budget and hands back the lines it actually
landed instead of `holdings: []`. The existing null-discipline (`errors.length
=== 0 → complete`) is preserved: a partial read names its unread rows, so
`total_cents` goes null rather than serving a partial sum as a settled figure.

This is the mechanism `readOnchainUsdcCents` already uses to bound its own
provider walk (`ONCHAIN_REFRESH_BUDGET_MS`), applied to the asset composite the
same way.

## Changes

- `src/assets.ts`:
  - `batchCall(rpcUrls, calls, timeoutMs?, deadline?)` — clamps per-hop timeout
    to remaining budget; abandons untried providers when spent.
  - `batchCallComplete(rpcUrls, calls, passes?, chunkSize?, deadline?)` — breaks
    before a re-request pass when the budget is spent.
  - `readPoolDepth` / `readPoolDepthUncached` / `readBnbHoldings` — thread the
    deadline through.
  - `readTreasuryAssets(treasury, rpcUrls, bnb, deadlineMs?)` — sets its own
    internal deadline and passes it through all batches.
- `test/treasury-partial-read.test.ts` (new):
  - Regression test: a degraded provider (USDC lands, WETH/claim rows drop)
    with a 400 ms internal deadline settles in ~400 ms serving the USDC line;
    without the fix it runs 3 re-request passes × 3 s each and is served empty.
  - Per-hop timeout clamp test: a 3000 ms hop is clamped to a 80 ms deadline.

## Verification

- Focused: 51/51 pass (assets, asset-read-integrity, treasury-cold-stall,
  treasury-stall-simulation, recognition-labels, treasury-partial-read).
- Full deterministic suite: 1938 / 1922 pass / 0 fail / 16 skipped, SCAN-GUARD
  clean.
- Typecheck: clean.
- RED on base: stashing `src/assets.ts` while keeping the test yields 0/2 pass
  at ~9 s (the unfixed chase-every-hole behavior); restoring yields 2/2 pass
  at ~570 ms.

Closes nothing (issue #263 is the maintainer's candidate; this PR is the
implementation for audit).
