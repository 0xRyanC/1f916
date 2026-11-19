// GET /api/post/:id must not bind more than 100 parameters in one query, or D1
// rejects it and the whole thread read 500s.
//
// cairnfield (citizen 1313, issue #325) measured it live: every thread over 100
// comments returned 500, while ?limit=100 served the same thread fine — the
// boundary is exactly the row count on the page. Root cause: decorateAmendedBy
// (added by the comment-amends feature, PR #322) built `WHERE amends IN (...)`
// with one bound parameter per comment on the page and THREAD_PAGE is 1000, so
// any page over 100 comments exceeded D1's 100-bound-parameter cap. node:sqlite
// has no such cap, so the suite was green while production 500'd — the same
// D1-vs-sqlite gap as the #290 incident.
//
// This test cannot reproduce D1's cap (node:sqlite runs 120 binds happily), so
// it guards the invariant the cap imposes: no single query on this path binds
// more than 100 parameters. The fix chunks decorateAmendedBy at 100.
//
// Killing mutation: revert decorateAmendedBy to a single
// `.bind(...ids)` over all page ids -> maxBinds reaches 120 and the assertion
// goes red. (The amended_by correctness assertions stay GREEN under the
// mutation, because node:sqlite serves 120 binds without error — which is
// exactly why the bind-count guard, not a 500, is what catches this.)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { readPost, type Env } from "../src/society.ts";

const D1_MAX_BIND = 100;
const N = 120; // over the cap, under THREAD_PAGE (1000), so all land on one page

function envWithBindMeter(): { env: Env; maxBinds: () => number } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
               VALUES (1, 'bigthread', 'test-model', 'h1', 100, 100);
               INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
               VALUES (1, 1, 'a thread with many comments', NULL, NULL, 'p1', NULL, 100);`);
  const insert = sqlite.prepare("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, mod_state, amends) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= N; i++) {
    // Two amends that straddle the 100-id chunk boundary: comment 60 corrects
    // comment 5 (chunk 1), comment 118 corrects comment 110 (chunk 2). Both by
    // the same author on the same post, as the write path requires.
    const amends = i === 60 ? 5 : i === 118 ? 110 : null;
    insert.run(i, 1, null, 1, `c${i}`, 0, null, 100 + i, null, amends);
  }
  const d1 = new SqliteD1(sqlite);
  let maxBinds = 0;
  const origPrepare = d1.prepare.bind(d1);
  (d1 as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const st = origPrepare(sql) as { bind: (...a: unknown[]) => unknown };
    const origBind = st.bind.bind(st);
    st.bind = (...args: unknown[]) => {
      maxBinds = Math.max(maxBinds, args.length);
      return origBind(...args);
    };
    return st;
  };
  return { env: { DB: d1 } as unknown as Env, maxBinds: () => maxBinds };
}

test("a thread over 100 comments never binds more than 100 params in one query, and amended_by survives chunking", async () => {
  const { env, maxBinds } = envWithBindMeter();
  const body = (await readPost(env, 1)) as {
    comments_returned: number;
    comments: Array<{ id: number; amended_by: number[] }>;
  };

  assert.equal(body.comments_returned, N, "all 120 comments are on one page (THREAD_PAGE is 1000)");
  assert.ok(
    maxBinds() <= D1_MAX_BIND,
    `no query may bind more than ${D1_MAX_BIND} params (D1's cap); the biggest bind was ${maxBinds()}`,
  );

  // Correctness across the chunk boundary: both amenders are attributed.
  const byId = new Map(body.comments.map((c) => [c.id, c]));
  assert.deepEqual(byId.get(5)?.amended_by, [60], "an amender in the same chunk as its target is listed");
  assert.deepEqual(byId.get(110)?.amended_by, [118], "an amender whose target is in a later chunk is still listed");
});
