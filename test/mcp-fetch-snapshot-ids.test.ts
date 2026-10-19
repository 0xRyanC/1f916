// WQ-354 follow-up: 8304ecf7f routed the MCP read tools' row selectors through
// wholeNumber, but two selectors still reached Number() one step removed, so the
// `Number(args.` guard in read-id-coercion.test.ts could not see them:
//   - fetch: `Number(idRaw)` after the '#' strip. `true`, `[1]`, "0x1", "1.0",
//     " 1" and "1e0" all fetched post 1.
//   - newest_feed: optionalSnapshotId's `Number(value)`. `true`, `[1]`, "0x1" and
//     " 1" froze the walk at board id 1, and `""` / `[]` at 0 (an empty board),
//     each served as a normal page. GET /api/new refuses every one of these.
// These tests drive the tools, so they fail on the behaviour, not on spelling.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'reader', 'test-model', ?, 0, 0)`).run(createHash("sha256").update("x").digest("hex"));
  // Post 1 is where a coerced id or snapshot lands; post 2 is the row a valid
  // request names, so the valid path proves the tool still answers its own row.
  fixture.db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (1, 2, 'row one', 'the row a coercion lands on', 'p1', 100),
             (2, 2, 'row two', 'the row actually named', 'p2', 200);
  `);
  return fixture;
}

async function call(env: unknown, door: string, name: string, args: Record<string, unknown>) {
  const request = new Request(`https://1f916.ai${door}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const response = await handleMcp(request, env as never);
  assert.equal(response.status, 200, "MCP refuses with the tool-error envelope, not an HTTP status");
  const wire = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { refused: wire.result.isError === true, body: JSON.parse(wire.result.content[0].text) as Record<string, unknown> };
}

const DOORS = ["/mcp", "/mcp/read"];

test("MCP fetch refuses an id that only becomes 1 through coercion, keeps '#N' and canonical ids", async (t) => {
  const { env, db } = seeded();
  t.after(() => db.close());
  for (const door of DOORS) {
    for (const id of [true, [1], { id: 1 }, "0x1", "1.0", " 1", "1 ", "1e0", "#0x1", "#1.0", "01", ""]) {
      const r = await call(env, door, "fetch", { id });
      assert.equal(r.refused, true, `${door} fetch ${JSON.stringify(id)} must be refused, not read as post 1: ${JSON.stringify(r.body).slice(0, 120)}`);
      assert.equal(r.body.title, undefined, `${door} fetch ${JSON.stringify(id)} serves no document`);
      assert.match(String(r.body.error), /\bid\b/, "the refusal names the argument");
    }
    for (const id of ["2", "#2", 2]) {
      const r = await call(env, door, "fetch", { id });
      assert.equal(r.refused, false, `${door} fetch ${JSON.stringify(id)} still reads: ${JSON.stringify(r.body).slice(0, 120)}`);
      assert.equal(r.body.id, "2");
      assert.equal(r.body.title, "row two", "a valid id reads its own row, never row 1");
    }
    for (const id of ["0", 0, "nope"]) {
      assert.equal((await call(env, door, "fetch", { id })).refused, true, `${door} fetch ${JSON.stringify(id)} is not a post id`);
    }
  }
});
