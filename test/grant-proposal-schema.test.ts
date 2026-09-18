// The grant-proposal detail schema (schemas/grant-proposal.json).
//
// WHERE IT SITS. /api/grants/:slug/proposals/:id is the one door that serves a
// full proposal brief: title, summary, body, the filing payload_hash and how to
// recompute it, and the revision links (what this supersedes / what superseded
// it). The grant list and the single-grant detail each carry only a compact
// proposal row; this is the full, isolated read a cited brief deserves.
//
// WHY THE CONTRACT MATTERS. A revision is a NEW row, never an edit, and votes
// live on the comment a proposal is filed under — so supersedes/superseded_by
// are the links that tell a reader which brief was live when a vote was cast.
// Losing the nullable-int shape, the boolean wants_to_build, the /api/post/:id
// thread, or the recipe that recomputes the filing hash would each be a break
// a citizen could not see from the list surface.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "grant-proposal.json"), "utf8"));

const doc = {
  now: 1789601380887,
  now_utc: "2026-09-16T23:29:40.887Z",
  id: 1,
  grant: "1f512",
  author: "packet-auditor",
  revision: 1,
  supersedes: null,
  superseded_by: null,
  title: "1f512.com: a registry of commitments that can be caught breaking",
  summary: "A lock's product is falsifiability, not custody.",
  body: "These tokens are locked, and the lock can be caught breaking.",
  wants_to_build: true,
  comment_id: 52661,
  thread: "/api/post/4710",
  payload_hash: "e843b127374ba58f5317876eb6d745e446d165a3",
  hash_recipe: "sha256 over JSON.stringify([grant_id, handle...]) with handle the author's handle at filing",
  selected: false,
  created_at: 1789050265266,
};

test("the grant proposal schema rejects the contract breaks it exists to catch", () => {
  assert.deepEqual(validate(schema, doc), [], "control: the live proposal shape passes");

  const bend = (mutate: (d: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy);
    return validate(schema, copy);
  };
  const rejects = (label: string, mutate: (d: Record<string, unknown>) => void) =>
    assert.ok(bend(mutate).length > 0, label);

  // The revision links are the core of this contract: null for an unlinked
  // first revision, but an integer when a successor exists. Reading either as
  // a bare string would lose the link.
  rejects("a supersedes that is a string instead of an integer-or-null", (d) => {
    d.supersedes = "3";
  });
  rejects("a superseded_by that is a string instead of an integer-or-null", (d) => {
    d.superseded_by = "3";
  });

  // wants_to_build is a boolean, not a flag that can be 1/0 from a row.
  rejects("a wants_to_build that is a number instead of a boolean", (d) => {
    d.wants_to_build = 1;
  });

  // The proposal names the comment it is filed under; losing the key severs
  // the ballot (a vote on a proposal is a vote on that comment). The key is
  // always served, so it stays required.
  rejects("a proposal losing its comment_id", (d) => {
    delete d.comment_id;
  });

  // A null comment_id is a state the code anticipates: the column is nullable
  // and readProposal serves it raw (src/grants.ts), a ballot-eligible count
  // filters with AND comment_id IS NOT NULL (src/grants.ts:267), and the
  // migration comment says NULL only if the write failed — the proposal
  // stands and cannot be voted for until the maintainer repairs the link.
  assert.deepEqual(bend((d) => { d.comment_id = null; }), [], "a null comment_id is accepted: filed, ballot link not yet repaired");

  // The thread is /api/post/<id>, never a bare number.
  rejects("a thread that is a number instead of the /api/post link", (d) => {
    d.thread = 4710;
  });

  // The filing hash is the honest part of the record; losing the recipe that
  // recomputes it is a break a reader cannot recover from.
  rejects("a proposal losing its hash_recipe", (d) => {
    delete d.hash_recipe;
  });
  rejects("a proposal losing its payload_hash", (d) => {
    delete d.payload_hash;
  });

  // The revision is 1-indexed; 0 (or a string) is not a filed revision.
  rejects("a revision of 0", (d) => {
    d.revision = 0;
  });

  // selected is a boolean, not an id.
  rejects("a selected that is the proposal id instead of a boolean", (d) => {
    d.selected = 1;
  });
});