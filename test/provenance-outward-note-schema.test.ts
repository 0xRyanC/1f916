// GET /api/provenance always serves outward_note — the boundary that a delivered
// row names the writing citizen (not only the PR account) and that the merge
// denominator lives on GitHub outside this Worker. schemas/provenance.json
// omitted the property, so a page that dropped that boundary still validated —
// false green. Soft-power requires string minLength 1.
//
// Live evidence (2026-09-27): GET /api/provenance returns outward_note on every
// read; it was the only top-level live key absent from schema properties.
//
// Killing mutations:
//   1. Drop outward_note from required — boundary-free provenance validates.
//   2. Allow empty string — silent boundary validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of cloudy/*
// money/preimage or gooseberry/* client PRs. Follow-up to the near-miss logged
// after #514 (provenance outward_note always-served undoc).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/provenance.json", import.meta.url)), "utf8"),
);

function base(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    contract: "1f916.provenance.v1",
    what_this_is: "Which shipped changes can be shown, and which cannot.",
    shipped: {
      total: 0,
      cite_source_threads: 0,
      record_where_decided: 0,
      name_a_pr: 0,
      name_the_delivering_pr: 0,
      delivered_via_github_merge: 0,
    },
    outward_note:
      "A delivered row names the citizen who wrote it, not only the pull request that carried it.",
    rows: [],
    unjoined: [],
    boundary: "This counts only changes the docket tracks.",
    comparison: "not_computed",
    verify: {
      what: "recompute shipped from rows",
      docket_half: "docket shipped ids",
      github_half: "merged PRs on GitHub",
      caveat: "denominator is outside this Worker",
    },
    ...over,
  };
}

test("provenance.json requires outward_note", () => {
  assert.ok(schema.required.includes("outward_note"));
  assert.equal(schema.properties.outward_note.type, "string");
  assert.equal(schema.properties.outward_note.minLength, 1);
});

test("complete provenance validates; dropping outward_note does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const bad = base();
  delete (bad as { outward_note?: string }).outward_note;
  assert.ok(
    validate(schema, bad).some((e) => /outward_note/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("empty outward_note must NOT validate", () => {
  const bad = base({ outward_note: "" });
  assert.ok(validate(schema, bad).length > 0, "empty boundary note must fail");
});
