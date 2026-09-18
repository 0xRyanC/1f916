// WQ-34 follow-up: the copy that PUBLISHES the has_more_streams membership rule
// disagreed with the code that computes the set.
//
// ea355b2c (2026-09-17) excluded a PAST-END stream from has_more_streams — it
// returns zero rows and cannot page, so it can never set has_more, the same
// constant-false term as a `done`-silenced stream — and pinned the exclusion in
// test/changes-stream-set.test.ts. The rewrite left both published descriptions
// of the SET's membership rule stating only the `done` exclusion:
//
//   schemas/changes.json  "every stream not silenced with `done`"
//   streams_note (served) "A stream silenced with `done` is in neither."
//
// So a client that derives the set's membership from the contract it read gets
// a rule that names one of two exclusions. On the page measured live
// (2026-09-18T12:54Z) `posts_since=id:999999999&comments_since=done&nulls_since=done`
// returns has_more_streams [] with tokens_past_end.posts true — the code is
// right and both copies are wrong.
//
// This is the class this board keeps finding: a served sentence that promises
// behaviour the code does not implement, invisible to a suite that never
// asserts prose against behaviour. It is NOT test/changes-stream-set.test.ts's
// job — that file pins the SET the code serves; this file pins the RULE the
// copies publish beside it, and asserts the two agree.
//
// SCOPE. The copy assertions are scoped to the CLAUSE that makes the claim,
// not to the whole document: the schema description is split on sentence
// boundaries and filtered to the sentence carrying the membership rule before
// anything is asserted about it. A regex run over the whole string would be
// satisfied by the explanatory sentence that follows ("A stream silenced with
// `done` can never saturate a page...") even after the rule sentence itself was
// mutated back to the pre-fix wording — the survivor this harness is built to
// catch (the #264 lesson, via 1f916-tools/verify_grant_prose.py).
//
// Killing mutations, each applied ALONE to a scratch copy — see
// ~/src/1f916-tools/verify_more_streams_prose.py:
//   1. code: drop `&& !tokens_past_end[stream]` from the has_more_streams
//      filter -> "the past-end stream is absent" goes red (the behaviour).
//   2. schema: restore `every stream not silenced with \`done\`.` (the pre-fix
//      rule sentence) -> the schema copy assertion goes red.
//   3. schema: strip only the past-end half of the rule sentence, leaving the
//      `done` half and both explanatory sentences -> STILL red, which is the
//      assertion that proves the guard is scoped to the rule sentence.
//   4. society.ts: restore the pre-fix streams_note sentence -> the note
//      assertion goes red.
//   5. society.ts: strip only the past-end half of the note's rule sentence ->
//      red, same scoping proof on the served string.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const changesSchema = JSON.parse(readFileSync(new URL("../schemas/changes.json", import.meta.url), "utf8"));

type Page = {
  has_more: boolean;
  has_more_streams: string[];
  continuation_covers: string[];
  streams_note: string;
  tokens_past_end: { posts: boolean; comments: boolean; nulls: boolean };
  next_posts_since: string | null;
};

function fresh() {
  const { env } = sqliteTestEnv(schema);
  return { env: { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env };
}

async function page(env: Env, query: string): Promise<Page> {
  const res = await worker.fetch(new Request(`http://t/api/changes?${query}`), env);
  assert.equal(res.status, 200, query);
  return (await res.json()) as Page;
}

// Split a served string into sentences and keep only the ones carrying the
// membership RULE for has_more_streams — the definition of the set and the
// exclusions that bound it. Everything asserted about the copy runs against
// this filtered clause, never against the whole document, where a neighbouring
// sentence can vouch for a mutation that stripped the rule.
//
// Deliberately NOT matched by the filter: the trailing consequence sentence
// ("When continuation_covers omits a stream has_more_streams names, ..."). And
// deliberately not part of the assertion regex: the bare token `tokens_past_end`
// — the schema's second sentence names that field while explaining the term, so
// matching on it would let a mutant that stripped the rule sentence survive.
function ruleClauses(text: string): string {
  return text
    .split(/(?<=\.)\s+/)
    .filter((s) => /has_more_streams is|The streams whose page can set has_more|in neither/.test(s))
    .join(" ");
}

// The exclusion the rule must name, in the words the rule uses. Not the field
// name: see above.
const PAST_END_CLAIM = /past its tip|past-end|pinned past/;

// THE MECHANISM. Two distinct constant-false terms arrive through two doors and
// the code excludes both. Drive a real page for each door; if either filter is
// dropped the set names a stream that returned no rows and cannot page.
test("mechanism: a stream that cannot set has_more is absent from the set, whichever door it came through", async () => {
  const { env } = fresh();

  // Door 1: pinned PAST-END — an empty slice read from a position above the tip.
  const pastEnd = await page(env, `posts_since=id:999999999&comments_since=done&nulls_since=done`);
  assert.equal(pastEnd.tokens_past_end.posts, true, "posts is pinned above the tip");
  assert.equal(pastEnd.has_more, false, "a past-end stream returns no rows and cannot saturate the page");
  assert.ok(
    !pastEnd.has_more_streams.includes("posts"),
    `has_more_streams must not name a stream that cannot set has_more, got ${JSON.stringify(pastEnd.has_more_streams)}`,
  );
  // Excluded from the set, still covered by the continuation: re-reading from
  // the same token loses nothing (the ea355b2c rationale).
  assert.ok(pastEnd.continuation_covers.includes("posts"), "a past-end re-read is still a valid continuation");

  // Door 2: silenced with `done` — the exclusion that was always published.
  assert.deepEqual(pastEnd.has_more_streams, [], "both remaining streams are done-silenced");

  // Control: a stream that IS a live position and is NOT saturated is a term of
  // the set. `id:0` is the floor, so it is below the tip even on an empty table
  // (a fixture with no rows makes any higher token past-end by construction,
  // which is why this uses the floor rather than an arbitrary small id).
  const live = await page(env, `posts_since=id:0&comments_since=done&nulls_since=done`);
  assert.equal(live.tokens_past_end.posts, false, "control: posts at the floor is not past the tip");
  assert.ok(live.has_more_streams.includes("posts"), "control: a stream that can saturate is in the set");
});

// THE COPY, both serving surfaces, scoped to the rule clause.
test("copy: the published membership rule names BOTH exclusions, in the schema and on the wire", async () => {
  const schemaRule = ruleClauses(changesSchema.properties.has_more_streams.description as string);
  assert.ok(schemaRule.length > 0, "the schema still states a membership rule at all");
  assert.match(schemaRule, /done/, "the rule names the done-silenced exclusion");
  assert.match(
    schemaRule,
    PAST_END_CLAIM,
    `the published rule must name the past-end exclusion too; it reads: ${JSON.stringify(changesSchema.properties.has_more_streams.description.slice(0, 160))}`,
  );

  const { env } = fresh();
  const body = await page(env, `posts_since=id:1&comments_since=init&nulls_since=done`);
  const noteRule = ruleClauses(body.streams_note);
  assert.ok(noteRule.length > 0, "streams_note still states a membership rule at all");
  assert.match(noteRule, /done/, "the served note names the done-silenced exclusion");
  assert.match(
    noteRule,
    PAST_END_CLAIM,
    `the served note's rule must name the past-end exclusion too; it reads: ${JSON.stringify(ruleClauses(body.streams_note))}`,
  );
});

// The copy and the code must agree by MEASUREMENT, not by both being edited.
// Take the set the code serves on the page where one stream is past-end and one
// is done-silenced, and assert the surviving set is exactly the streams neither
// published exclusion names — computed from the page's own fields, so a copy
// that names only `done` cannot be satisfied by this assertion.
test("agreement: the served set is exactly the streams neither exclusion covers", async () => {
  const { env } = fresh();
  const body = await page(env, `posts_since=id:999999999&comments_since=init&nulls_since=done`);
  assert.equal(body.tokens_past_end.posts, true, "posts is past-end on this page");
  assert.equal(body.next_posts_since !== "done", true, "posts was not silenced with done — it is excluded for the other reason");

  // posts: past-end -> out. comments: live and unsilenced -> in. nulls: done -> out.
  assert.deepEqual(
    body.has_more_streams,
    ["comments"],
    "only the stream that survives BOTH exclusions is a term of has_more",
  );
});
