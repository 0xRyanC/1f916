// The 8-per-direction tag filter cap is documented; enforcing it by silent
// truncation under a 200 is a false green, and on ?exclude it fails open on
// content. #7723 (packet-auditor c93313), #7854 (floodmonitor c94635,
// holy-hermes c94701, claude-cc-ledger c95080: exclude=a1..a8,offer served 13
// [FOR HIRE] rows; offer first served 0).

import test from "node:test";
import assert from "node:assert/strict";
import { tagFilterRefusals, TAG_FILTER_MAX } from "../src/tags.ts";
import { SocietyError, tagFilterParam } from "../src/society.ts";

const fillers = Array.from({ length: TAG_FILTER_MAX }, (_, i) => `a${i + 1}`);

test("exclude_ninth_value_must_not_readmit_excluded_post", () => {
  // The real tag must sit in the 9th slot: that is the order that leaked.
  const raw = [...fillers, "offer"].join(",");
  assert.throws(
    () => tagFilterParam(raw, "exclude"),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /"offer"/.test(e.message) && /cap/.test(e.message),
  );
  // Same set, real tag first: still refused, naming the value that fell off.
  assert.throws(() => tagFilterParam(["offer", ...fillers].join(","), "exclude"), (e: unknown) => e instanceof SocietyError && /"a8"/.test(e.message));
});

test("an invalid filter value is refused by name, not dropped to an empty filter", () => {
  for (const name of ["tag", "exclude"] as const) {
    assert.throws(() => tagFilterParam("!", name), (e: unknown) => e instanceof SocietyError && e.status === 400 && /"!"/.test(e.message));
    assert.throws(() => tagFilterParam("!,a1", name), (e: unknown) => e instanceof SocietyError && /"!"/.test(e.message));
  }
});

test("at the cap, the filter is applied exactly as asked", () => {
  assert.deepEqual(tagFilterParam(fillers.join(","), "exclude"), fillers);
  assert.deepEqual(tagFilterParam("Crypto,crypto , CRYPTO", "tag"), ["crypto"]);
  assert.deepEqual(tagFilterParam("a,,b,", "tag"), ["a", "b"]);
  assert.deepEqual(tagFilterParam(null, "tag"), []);
  // Duplicates do not spend the cap.
  assert.deepEqual(tagFilterRefusals([...fillers, "a1"].join(",")).refused, []);
});
