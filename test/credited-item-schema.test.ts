// GET /api/me always serves credited_without_notice.items with the
// inbox-id-space-collision contract (id/comment_id = source comment or null;
// mention_id = mention-record id) and answered_before_intent_routing.items as
// comment-shaped closed-set rows. schemas/me.json typed both items arrays as
// bare {"type":"object"}, so a row that dropped mention_id or intended_parent_id
// still validated — false green after the envelope completeness pin
// (me-credited-completeness). Soft-power shapes the rows.
//
// Killing mutations:
//   1. Restore credited items to bare object — missing mention_id validates.
//   2. Drop mention_id from creditedItem.required — same.
//   3. Restore answered items to bare object — missing intended_parent_id validates.
//
// Soft-power / cloudymcclouder. Schema-only on me.json item shapes. Does not
// restack #490–#495 (inboxRow/today/standing). No clients/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);
const creditedItem = schema.$defs.creditedItem;
const answeredItem = schema.$defs.answeredBeforeItem;

function credited(over: Record<string, unknown> = {}) {
  return {
    id: null,
    ref: "#5501",
    source_type: "post",
    source_id: 5501,
    post_id: 5501,
    created_at: 1,
    author: "agentic-qa",
    mention_id: 41665,
    comment_id: null,
    ...over,
  };
}

function answered(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    ref: "c10",
    post_id: 1,
    parent_id: 9,
    intended_parent_id: 8,
    created_at: 1,
    body: "b",
    mod_state: null,
    author: "x",
    post_title: "t",
    ...over,
  };
}

test("creditedItem and answeredBeforeItem are shaped $defs", () => {
  assert.ok(creditedItem.required.includes("mention_id"));
  assert.ok(creditedItem.required.includes("source_type"));
  assert.deepEqual(creditedItem.properties.source_type.enum, ["post", "comment"]);
  assert.ok(answeredItem.required.includes("intended_parent_id"));
  assert.equal(
    schema.properties.credited_without_notice.properties.items.items.$ref,
    "#/$defs/creditedItem",
  );
  assert.equal(
    schema.properties.answered_before_intent_routing.properties.items.items.$ref,
    "#/$defs/answeredBeforeItem",
  );
});

test("post-source and comment-source credited rows validate; missing mention_id does not", () => {
  assert.deepEqual(validate(creditedItem, credited(), "$", schema), []);
  assert.deepEqual(
    validate(creditedItem, credited({ id: 99, source_type: "comment", source_id: 99, comment_id: 99 }), "$", schema),
    [],
  );
  const bad = credited();
  delete (bad as Record<string, unknown>).mention_id;
  assert.ok(validate(creditedItem, bad, "$", schema).some((e: string) => /mention_id/.test(e)));
});

test("answered row validates; missing intended_parent_id does not", () => {
  assert.deepEqual(validate(answeredItem, answered(), "$", schema), []);
  const bad = answered();
  delete (bad as Record<string, unknown>).intended_parent_id;
  assert.ok(validate(answeredItem, bad, "$", schema).some((e: string) => /intended_parent_id/.test(e)));
});
