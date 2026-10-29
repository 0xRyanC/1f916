// GET /api/docket always serves acceptance_coverage, decomposition,
// source_coverage, source_graph, shaped counts, how_to_contribute
// {repo,format,note}, and how_it_was_built. schemas/docket.json left counts
// and how_to_contribute as bare objects and omitted the four coverage blocks,
// so a reply that dropped acceptance_coverage or flattened counts still
// validated — false green. Soft-power pins them.
//
// Not a twin of the rejected "how_to_contribute thin" near-miss (that was a
// how_to_contribute-only invention). This is completeness across always-served
// coverage fields, same class as official-completeness (#507).
//
// Killing mutations:
//   1. Drop acceptance_coverage from required — reply without it validates.
//   2. Restore counts to bare object — non-integer status counts validate.
//   3. Drop repo from how_to_contribute.required — incomplete contribute block validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/docket.json", import.meta.url)), "utf8"),
);

const COVERAGE = [
  "acceptance_coverage",
  "decomposition",
  "source_coverage",
  "source_graph",
  "how_it_was_built",
];

test("docket.json requires coverage blocks and shapes counts + how_to_contribute", () => {
  for (const k of COVERAGE) {
    assert.ok(schema.required.includes(k), k);
    assert.ok(schema.properties[k], k);
  }
  const counts = schema.properties.counts;
  assert.equal(counts.additionalProperties.type, "integer");
  const htc = schema.properties.how_to_contribute;
  for (const k of ["repo", "format", "note"] as const) {
    assert.ok(htc.required.includes(k), k);
  }
});

test("shaped counts / how_to_contribute / acceptance_coverage validate; bare counts do not", () => {
  assert.deepEqual(validate(schema.properties.counts, { open: 1, shipped: 2 }), []);
  assert.ok(validate(schema.properties.counts, { open: "x" }).length > 0);
  assert.deepEqual(
    validate(schema.properties.how_to_contribute, {
      repo: "https://github.com/1f916-ai/1f916",
      format: "1) claim",
      note: "n",
    }),
    [],
  );
  const bad: Record<string, unknown> = { repo: "r", format: "f" };
  assert.ok(validate(schema.properties.how_to_contribute, bad).some((e: string) => /note/.test(e)));
  assert.deepEqual(
    validate(schema.properties.acceptance_coverage, {
      note: "n",
      live_rows: 1,
      with_acceptance: 1,
      without_acceptance: 0,
      by_lane: { spec: { with: 1, without: 0 } },
    }),
    [],
  );
});
