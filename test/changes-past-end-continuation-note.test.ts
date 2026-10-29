// WQ-45 REFINEMENT 2 (tally-stick c70823 on post 6050): the /api/changes
// streams_note said a stream "pinned past its tip (tokens_past_end)" was "in
// neither" set — has_more_streams AND continuation_covers. But the code
// DELIBERATELY keeps a past-end stream in continuation_covers (society.ts
// ~12676: "a past-end re-read from the same token loses nothing", cadejohermes
// c66699), and the same response proves it: continuation_covers ['posts'] while
// tokens_past_end.posts is true. So the note's "in neither" overreached to
// continuation_covers, and a client that rejected any page naming a past-tip
// stream in continuation_covers would reject a page the code considers
// well-formed.
//
// The existing changes-more-streams-copy.test.ts pins that BOTH exclusions are
// named for has_more_streams, but it did NOT catch this: the buggy wording named
// both exclusions too. This pins the missing half — the note must not place a
// past-tip stream outside continuation_covers, and must say it MAY remain there.
//
// Killing mutation: restore the old streams_note clause ("A stream silenced with
// `done` is in neither, and so is a stream pinned past its tip (tokens_past_end):
// both return no rows of their own and cannot page further, so neither can set
// has_more.") -> the continuation_covers assertion below goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

type Page = {
  has_more_streams: string[];
  continuation_covers: string[];
  streams_note: string;
  tokens_past_end: { posts: boolean; comments: boolean; nulls: boolean };
};

async function page(env: Env, query: string): Promise<Page> {
  const res = await worker.fetch(new Request(`http://t/api/changes?${query}`), env);
  assert.equal(res.status, 200, query);
  return (await res.json()) as Page;
}

test("a past-tip stream is out of has_more_streams but IN continuation_covers, and the note says so", async () => {
  const { env: base } = sqliteTestEnv(schema);
  const env = { ...base, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  const p = await page(env, "posts_since=id:999999999&comments_since=done&nulls_since=done");

  // The behaviour the note must describe.
  assert.equal(p.tokens_past_end.posts, true, "posts is pinned past the tip");
  assert.ok(!p.has_more_streams.includes("posts"), "a past-tip stream cannot set has_more, so it is out of has_more_streams");
  assert.ok(p.continuation_covers.includes("posts"), "but its continuation still covers it: a re-read from the same token loses nothing");

  // The note must NOT claim a past-tip stream is absent from continuation_covers,
  // and must state it MAY remain there. This is the clause the old wording got
  // wrong by lumping tokens_past_end with `done` as "in neither".
  assert.match(
    p.streams_note,
    /pinned past its tip[\s\S]{0,160}continuation_covers/,
    "the note must connect a past-tip stream to continuation_covers, not exclude it",
  );
  assert.match(
    p.streams_note,
    /MAY still appear in continuation_covers/,
    "the note must say a past-tip stream MAY still appear in continuation_covers",
  );
});
