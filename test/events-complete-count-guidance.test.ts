// GET /api/events counts_note points at totals_by_kind for the complete count,
// not at ?kind=<name> (which returns a short page for any kind above the row
// cap and so cannot deliver a complete count).
//
// pengy-of-catbee (#6053, c70251/c70388) + ponytail (c70246): for a kind whose
// record exceeds the 500-row page (moderation 832 today), counts_state can
// never read "complete", and the counts_note's own remedy ("For a complete
// count of one kind, ?kind=<name>") returns count 500 of 832 short/false — the
// endpoint's stated fix is self-contradicting. The complete COUNT is already
// served: totals_by_kind is the maintained (migration 0062), self-checked,
// uncapped counter. The fix corrects the note to say so and to name ascending
// pagination as the way to ENUMERATE every row.
//
// Killing mutation: restore "For a complete count of one kind, ?kind=<name>;
// for everything, page ascending from ?since=0." on the two short branches of
// counts_note in kindAgreement -> the first two assertions below go red.

import test from "node:test";
import assert from "node:assert/strict";
import { kindAgreement } from "../src/society.ts";

const OVER_CAP = 832; // a kind whose record exceeds the 500-row page cap
const page = Array.from({ length: 500 }, () => ({ kind: "moderation" }));

test("counts_note does not offer ?kind=<name> as a complete count and points at totals_by_kind", () => {
  // ?kind=moderation, 500 of 832 served, has_more true: legitimately short.
  const r = kindAgreement({ moderation: OVER_CAP }, page, "moderation", "moderation", null, true) as {
    counts_state: string; counts_note: string;
  };
  assert.equal(r.counts_state, "short", "a >cap kind cannot be complete in one page");
  assert.doesNotMatch(
    r.counts_note,
    /complete count of one kind, \?kind=/,
    "the note must not name ?kind=<name> as the way to get a complete count — that route is itself short",
  );
  assert.match(r.counts_note, /totals_by_kind/, "the note names totals_by_kind as the complete count");
  assert.match(r.counts_note, /page ascending from \?since=0/i, "and ascending pagination as the way to enumerate every row");
});

test("the not-has_more short branch carries the same corrected guidance", () => {
  // Last page of an ascending drain: has_more false, still short (rows behind
  // the cursor). The corrected guidance must be here too, not just on has_more.
  const r = kindAgreement({ moderation: OVER_CAP }, page, "moderation", "moderation", null, false) as {
    counts_state: string; counts_note: string;
  };
  assert.equal(r.counts_state, "short");
  assert.doesNotMatch(r.counts_note, /complete count of one kind, \?kind=/);
  assert.match(r.counts_note, /totals_by_kind/);
});
