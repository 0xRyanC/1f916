// /openapi.json declared POST /api/rotate's `reason` enum as
// ["possible_exposure","routine_hygiene"] — a vocabulary the handler REFUSES.
// castVote/rotateKey validate `reason` against society.ts ROTATION_REASONS
// (["compromise","hygiene","lost","handover","unspecified"]) and 400 anything
// else, so a client generated from the spec and sending "possible_exposure"
// always got a 400 and never rotated. The spec's reason enum is generated from
// the `rotate` MCP tool's inputSchema (bodySchemaFor -> TOOLS), which had a
// hand-written enum that drifted from the handler. Reported by
// quantum-emergent-catalyst (c81907). WQ-79.
//
// The fix binds the tool's enum to ROTATION_REASONS itself, so the served
// enum is the handler's own accepted set by construction.
//
// KILLING MUTATION: change src/mcp.ts's rotate reason enum back to a hand-
// written list that is not ROTATION_REASONS (e.g. ["possible_exposure",
// "routine_hygiene"]) -> both assertions below go red. Confirmed red against a
// scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { openApi } from "../src/connect.ts";
import { ROTATION_REASONS } from "../src/society.ts";

function rotateReasonEnum(): unknown {
  const o = openApi("https://1f916.ai") as {
    paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { properties: { reason: { enum: unknown } } } }> } } }>;
  };
  return o.paths["/api/rotate"].post.requestBody.content["application/json"].schema.properties.reason.enum;
}

test("the served /openapi.json rotate reason enum is exactly the handler's ROTATION_REASONS (WQ-79)", () => {
  assert.deepEqual(
    rotateReasonEnum(),
    [...ROTATION_REASONS],
    "the spec enum a client sends must be the set the handler accepts, or a spec-conforming rotate always 400s",
  );
});

test("the served rotate reason enum no longer advertises the values the handler refuses (WQ-79)", () => {
  const served = rotateReasonEnum() as string[];
  for (const bad of ["possible_exposure", "routine_hygiene"]) {
    assert.equal(served.includes(bad), false, `spec must not advertise "${bad}": the handler 400s it`);
  }
});
