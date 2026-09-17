// `since` is resolved once, before the validator, so the tag and the page agree
// about it and a request the endpoint refuses is refused before the 304.
//
// Two defects from resolving it late (changes() defaulted an absent since to 0
// after changesValidator had folded the raw NaN into the tag). On the init arm,
// since omitted and since=0 served one body under two validators
// (chg1-NaN:init:init:... and chg1-0:init:init:...; egress, c66241 on #5527).
// In legacy mode an absent since is refused 400, but the route computed a tag
// first and compared If-None-Match against it, so `*` answered 304 to a request
// that answers 400 without the header.
//
// Killing mutation: delete the resolveChangesSince call in changesValidator
// and both end-to-end tests go red.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { resolveChangesSince, SocietyError, type Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh(): Env {
  const { env } = sqliteTestEnv(schema);
  return { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
}

const get = (env: Env, query: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`http://t/api/changes?${query}`, { headers }), env);

const INIT = "posts_since=init&comments_since=init&nulls_since=done";

describe("resolveChangesSince", () => {
  test("absent (NaN) floors at zero in lossless mode and is refused in legacy mode", () => {
    assert.equal(resolveChangesSince(NaN, "init"), 0);
    assert.equal(resolveChangesSince(NaN, { kind: "live", id: 7 }), 0);
    assert.equal(resolveChangesSince(1789521000000, "init"), 1789521000000);
    assert.throws(() => resolveChangesSince(NaN, null), (err: unknown) => err instanceof SocietyError && err.status === 400);
  });
});

describe("end to end: the validator and the page see the same since", () => {
  test("init arm: since omitted and since=0 are one representation and one tag, with no NaN in it", async () => {
    const env = fresh();
    const omitted = await get(env, INIT);
    const zero = await get(env, `since=0&${INIT}`);
    assert.equal(omitted.status, 200);
    assert.equal(zero.status, 200);
    const omittedTag = omitted.headers.get("ETag")!;
    assert.equal(omittedTag, zero.headers.get("ETag"), "one body, one validator");
    assert.doesNotMatch(omittedTag, /NaN/, "the tag carries the since the page served, not the raw parse");
    await omitted.body?.cancel();
    await zero.body?.cancel();
    const again = await get(env, INIT, { "If-None-Match": omittedTag });
    assert.equal(again.status, 304);
    const crossed = await get(env, `since=0&${INIT}`, { "If-None-Match": omittedTag });
    assert.equal(crossed.status, 304, "either spelling revalidates the other");
  });

  test("legacy mode: an absent since is 400 with or without If-None-Match, never 304", async () => {
    const env = fresh();
    const plain = await get(env, "nulls_since=done");
    assert.equal(plain.status, 400);
    await plain.body?.cancel();
    const star = await get(env, "nulls_since=done", { "If-None-Match": "*" });
    assert.equal(star.status, 400, "a request the endpoint refuses is refused before the 304 short-circuit");
    await star.body?.cancel();
  });
});
