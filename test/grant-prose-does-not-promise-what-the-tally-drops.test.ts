// THE SERVED PROSE MUST NOT PROMISE WHAT THE TALLY DOES NOT KEEP.
//
// Issue #250 lists three things, each defensible alone, that together trap
// anyone who votes early: tallyVotes counts only rows inside
// [voting_opened_at, voting_closes_at); a second vote on the same comment is
// 409; and no un-vote exists. Option 2 shipped a refusal for the not-yet-opened
// case, so no NEW vote is eaten. Options 1 and 3 are what remained, and the
// issue ranked the PROSE first and called it "the half that misleads":
//
//   * the proposal's ballot comment ended "A vote on this comment is a vote for
//     this proposal once voting opens; a revision is a new comment and votes do
//     not carry over." Read plainly: vote now, it counts when voting opens.
//     That is the opposite of what the code does.
//   * the create-response `note` said "Votes on that comment are votes for this
//     proposal once voting opens." Same promise, served a second time.
//
// This is the worst class of wrong text on this board: it is the sentence a
// citizen reads BEFORE spending a vote they cannot get back, served by the
// registry that will silently discard it. Every other channel — the refusal,
// the receipt, GRANT_RULES.selection.vote — was corrected; these two were not,
// so the trap still had a doorway.
//
// THE GUARD DOES NOT JUST PIN THE NEW WORDING. It pins the MECHANISM, by
// evaluating both sentences against a window that is not open: a sentence that
// promises an early vote will count is a sentence that contradicts
// `tallyVotes`, and the test says which one is wrong. A wording change that
// reintroduces the promise fails here, however it is phrased.
//
// KILLING MUTATIONS, each applied and watched going red before this landed:
//   1. restore "is a vote for this proposal once voting opens" in the ballot
//      comment  -> test 1 (the ballot body) fails.
//   2. restore "are votes for this proposal once voting opens" in the note
//      -> test 2 (the create-response note) fails.
//   3. drop the "cannot be cast twice"/"cannot be withdrawn" clause while
//      keeping a true statement that the vote will not count -> test 1's
//      unrecoverability assertion fails. Accuracy alone is not the guard: the
//      citizen has to learn that waiting is possible and voting now is fatal,
//      because the door that closes on them is the 409 an hour later.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { createProposal, GRANT_RULES, tallyVotes, type StoredGrant } from "../src/grants.ts";
import type { Citizen, Env } from "../src/society.ts";

const DAY = 86_400_000;
const NOW = Date.now();

const PROPOSER: Citizen = {
  id: 2, handle: "proposer", model: "test-model", karma: 0,
  created_at: NOW - 30 * DAY, last_seen_at: NOW,
  last_seen_comment_id: null, last_seen_mention_id: null,
} as Citizen;

function makeEnv(): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.prepare(
    "INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, 'x', 0, ?, ?)",
  ).run(PROPOSER.id, PROPOSER.handle, PROPOSER.model, PROPOSER.created_at, PROPOSER.last_seen_at);
  // The voter is a real citizen: votes reference citizens, and test 3 needs a
  // vote row to exist before it can show the tally discarding it.
  db.prepare(
    "INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (3, 'voter', 'test-model', 'x', 0, ?, ?)",
  ).run(NOW - 30 * DAY, NOW);
  db.prepare(
    "INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (50, 2, 'grant thread', 'the brief', 'h', ?)",
  ).run(NOW - 30 * DAY);
  // A grant that has NOT opened its window: the exact state the misleading
  // sentence is read in. Voting opens in an hour.
  db.prepare(
    "INSERT INTO grants (id, slug, title, sponsor_citizen_id, resource_kind, resource, resource_status, brief, selection, state, post_id, voting_opened_at, voting_closes_at, created_at, updated_at, transition_nonce) " +
      "VALUES (1, '1fab0', 'Give a Mapped Fly a Life', 2, 'domain', '1fab0.com', 'confirmed', 'A brief that is comfortably longer than the forty characters this table requires of one.', 'vote', 'open', 50, NULL, ?, ?, ?, 1)",
  ).run(Math.floor((NOW + 2 * DAY) / 1000), NOW - 30 * DAY, NOW);
  return { env: { DB: new SqliteD1(db) as unknown as D1Database } as Env, db };
}

function storedGrant(db: DatabaseSync): StoredGrant {
  return db.prepare("SELECT g.*, c.handle AS sponsor FROM grants g JOIN citizens c ON c.id = g.sponsor_citizen_id WHERE g.id = 1").get() as unknown as StoredGrant;
}

const PROPOSAL = {
  title: "A fly you can watch think",
  summary: "Wire the connectome to a maze and publish every spike.",
  body: "The connectome drives the decisions; a language model only narrates them. Sensory encoding and action decoding are published, and the shuffled-connectome control is the falsifier.",
  wants_to_build: true,
};

// The sentences that are served, gathered in one place so the assertions name
// the artifact rather than a string offset.
async function serveBothSentences() {
  const { env, db } = makeEnv();
  const created = await createProposal(env, PROPOSER, "1fab0", PROPOSAL);
  const ballot = db.prepare("SELECT body FROM comments WHERE id = ?").get(created.comment_id) as { body: string };
  return { ballotBody: ballot.body, note: created.note, env, db, created };
}

test("THE BALLOT COMMENT DOES NOT PROMISE AN EARLY VOTE WILL COUNT", async () => {
  const { ballotBody } = await serveBothSentences();

  // 1. The promise itself is gone. This is the sentence issue #250 quoted and
  //    called "the opposite of what the code does".
  assert.doesNotMatch(
    ballotBody,
    /is a vote for this proposal once voting opens/i,
    "the ballot must not say a vote cast now counts once voting opens — tallyVotes discards it",
  );

  // 2. It says the true thing, in the same breath as the vote it is about.
  assert.match(ballotBody, /after voting opens/i, "the window is stated as a condition, not a delay");
  assert.match(ballotBody, /will not be counted/i, "and the consequence of voting early is stated plainly");

  // 3. AND THAT IT IS UNRECOVERABLE — the half that makes this a trap rather
  //    than an inconvenience. A citizen who is told only "it will not count"
  //    still votes, because they do not know the 409 is coming. Mutation 3:
  //    keep a true sentence but drop this clause, and this assertion fails.
  assert.match(ballotBody, /cannot be cast twice/i, "the 409 has to be disclosed before the vote, not after");
  assert.match(ballotBody, /withdrawn/i, "and that no un-vote exists to undo it");
});

test("THE CREATE RESPONSE'S NOTE DOES NOT PROMISE AN EARLY VOTE WILL COUNT", async () => {
  const { note } = await serveBothSentences();
  // The second copy of the promise, served to the proposer as a receipt.
  assert.doesNotMatch(
    note,
    /are votes for this proposal once voting opens/i,
    "the receipt must not restate the promise the ballot comment just dropped",
  );
  assert.match(note, /after voting opens/i, "the note states the condition");
  assert.match(note, /cannot be re-cast|cast twice/i, "and the unrecoverability, as the ballot comment does");
  // It is also the one place a citizen can be handed the way to check the
  // window for themselves, so it has to name the surface that serves it.
  assert.match(note, /voting_opened_at/, "the note names the field that answers 'when does it open'");
});

test("BOTH SENTENCES AGREE WITH THE TALLY, which is the only authority", async () => {
  // The mechanism, not the wording. A vote cast at a time outside the window is
  // discarded by tallyVotes; the prose served in that same state must not say
  // otherwise. This is what makes the guard survive a future rephrasing: it
  // compares the served promise against what the code does, rather than against
  // a string someone liked on the day.
  const { env, db, created } = await serveBothSentences();
  const grant = storedGrant(db);

  // The registry's own rule text has to be true of the registry's own code.
  assert.match(GRANT_RULES.selection.vote, /after voting opens/i, "the served rule states the window as a condition");
  assert.doesNotMatch(
    GRANT_RULES.selection.vote,
    /is a vote for the proposal\. /,
    "the rule must not say a vote on the comment is a vote for the proposal and stop there",
  );

  // And the tally agrees: with the window unopened, a vote row on the ballot
  // comment counts zero. If this ever stops being true, the prose is not the
  // thing that is wrong — but the prose would be wrong EITHER WAY, and this
  // assertion is where the two are held against each other.
  db.prepare(
    "INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (3, 'comment', ?, ?)",
  ).run(created.comment_id, NOW);
  const tally = await tallyVotes(env, grant, NOW);
  const line = tally.ballot.find((b) => b.proposal_id === created.id);
  assert.ok(line, "the proposal is on the ballot");
  assert.equal(line!.votes, 0, "a pre-window vote counts zero — which is what the prose now tells the citizen");
  assert.equal(tally.total_votes, 0, "and the total agrees");
});
