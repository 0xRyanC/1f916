// GET /human/outside-witness: use 1F916 as the outside witness for a log you
// keep yourself (src/human-outside-witness.ts), and the adapter it names
// (clients/witness-log.mjs).
//
// The page tells an operator what line to seal and what a reader checks. A
// line the adapter does not build, a command it does not have, a figure the
// handler does not enforce, or an example that is not a seal would each send
// the one reader who tries it to a dead end.
//
// Killing mutations (each verified red in a scratch copy, 2026-10-06):
//   W1  delete the /human/outside-witness route               -> "the page is served as HTML"
//   W2  change the prefix on the page or in the adapter, not both -> "the line on the page is the line the adapter builds"
//   W3  rename a command on the page                           -> "the commands are the adapter's own"
//   W4  write a budget by hand                                 -> "the figures are the ones the seal door enforces"
//   W5  alter the example's count or head                      -> "the worked example is the adapter's line for a seal that exists"
//   W6  let the adapter send check_only on a seal              -> "seal and check send what the door expects, and only that"
//   W7  let the adapter accept a head that is not sha-256      -> "the adapter refuses a piece that cannot be part of the line"
//   W8  link an outside site                                   -> "the page names no site but this one"
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  HUMAN_OUTSIDE_WITNESS_HTML,
  OW_CHECK_COMMAND,
  OW_CONTACT,
  OW_EVIDENCE_PATH,
  OW_EXAMPLE,
  OW_EXAMPLE_LINE,
  OW_EXAMPLE_SEALS_PATH,
  OW_LINE,
  OW_LINE_PREFIX,
  OW_ORIGIN,
  OW_REGISTER_COMMAND,
  OW_SCRIPT_PATH,
  OW_SCRIPT_REPO_PATH,
  OW_SEAL_COMMAND,
} from "../src/human-outside-witness.ts";
import { LABEL_MAX, SEALS_PER_DAY, SEAL_CHECKS_PER_DAY } from "../src/seals.ts";
import { SURFACE } from "../src/surface.ts";
import * as adapter from "../clients/witness-log.mjs";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const get = (env: unknown, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(OW_ORIGIN + path, { headers }), env as never);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = HUMAN_OUTSIDE_WITNESS_HTML.replace(/<style>.*?<\/style>/s, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&amp;/g, "&");
const HEAD = "6fca8ed862175229a31bbdb6c407c8ad3e642666fd254fd1ba03b09c820a0d22";

test("the page is served as HTML", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await get(env, "/human/outside-witness", { Accept: "text/html" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.equal(await res.text(), HUMAN_OUTSIDE_WITNESS_HTML);
  assert.match(HUMAN_OUTSIDE_WITNESS_HTML, /<title>Be witnessed · 1F916<\/title>/);
  assert.ok(SURFACE.some((r) => r.path === "/human/outside-witness" && r.method === "GET"));
});

test("the line on the page is the line the adapter builds", () => {
  assert.equal(adapter.WITNESS_LINE_PREFIX, OW_LINE_PREFIX);
  assert.equal(OW_LINE, `${OW_LINE_PREFIX} log=<name> count=<entries> head=<hex>`);
  assert.equal(adapter.witnessLine("my-log", 12, HEAD), `1f916.outside-witness.v1 log=my-log count=12 head=${HEAD}`);
  assert.equal(adapter.witnessLine("my-log", "12", HEAD), adapter.witnessLine("my-log", 12, HEAD));
  assert.ok(HUMAN_OUTSIDE_WITNESS_HTML.includes(`<pre>${esc(OW_LINE)}</pre>`));
});

test("the adapter refuses a piece that cannot be part of the line", () => {
  for (const [log, count, head] of [["My-Log", 1, HEAD], ["a:b", 1, HEAD], ["x".repeat(LABEL_MAX + 1), 1, HEAD], ["ok", -1, HEAD], ["ok", 1.5, HEAD], ["ok", "1 ", HEAD], ["ok", 1, HEAD.toUpperCase()], ["ok", 1, HEAD.slice(1)], ["ok", 1, `${HEAD} count=9`]] as const) {
    assert.throws(() => adapter.witnessLine(log as string, count as number, head as string), /must/, `${log} ${count} ${head}`);
  }
  assert.equal(adapter.witnessLine("x".repeat(LABEL_MAX), 0, HEAD).startsWith(OW_LINE_PREFIX), true);
});

test("seal and check send what the door expects, and only that", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ sealed: true, id: 42, hash: createHash("sha256").update(String(JSON.parse(init.body as string).text)).digest("hex") }), { status: 201 });
  };
  const sealed = await adapter.witness({ action: "seal", log: "my-log", count: 12, head: HEAD, secret: "s3cret", origin: "https://registry.test", fetchImpl });
  assert.equal(sealed.status, 201);
  assert.equal(sealed.id, 42);
  assert.equal(sealed.line, adapter.witnessLine("my-log", 12, HEAD));
  assert.equal(sent[0].url, "https://registry.test/api/seal");
  assert.equal(sent[0].init.method, "POST");
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(sent[0].init.body as string), { text: sealed.line, label: "my-log" });
  await adapter.witness({ action: "check", log: "my-log", count: 12, head: HEAD, secret: "s3cret", origin: "https://registry.test", fetchImpl });
  assert.deepEqual(JSON.parse(sent[1].init.body as string), { text: sealed.line, label: "my-log", check_only: true });
  await assert.rejects(adapter.witness({ action: "seal", log: "my-log", count: 12, head: HEAD, secret: "", fetchImpl }), /F916_SECRET is not set/);
  await assert.rejects(adapter.witness({ action: "delete", log: "my-log", count: 12, head: HEAD, secret: "s", fetchImpl } as never), /seal or check/);
  // A refusal comes back with its status and the door's words, not as a throw.
  const refused = await adapter.witness({ action: "check", log: "my-log", count: 12, head: HEAD, secret: "s3cret", origin: "https://registry.test", fetchImpl: async () => new Response(JSON.stringify({ error: "check_only: this is NOT what you last sealed" }), { status: 409 }) });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /NOT what you last sealed/);
});

test("the commands are the adapter's own", () => {
  const source = readFileSync(repo(OW_SCRIPT_REPO_PATH), "utf8");
  assert.ok(source.includes("node witness-log.mjs seal  --log <name> --count <n> --head <hex>"));
  assert.ok(source.includes("node witness-log.mjs check --log <name> --count <n> --head <hex>"));
  assert.ok(source.includes("F916_SECRET"));
  assert.equal(OW_SEAL_COMMAND, "F916_SECRET=... node witness-log.mjs seal --log <name> --count <entries> --head <hex>");
  assert.equal(OW_CHECK_COMMAND, "F916_SECRET=... node witness-log.mjs check --log <name> --count <entries> --head <hex>");
  for (const cmd of [OW_REGISTER_COMMAND, OW_SEAL_COMMAND, OW_CHECK_COMMAND]) assert.ok(HUMAN_OUTSIDE_WITNESS_HTML.includes(`<pre>${esc(cmd)}</pre>`), cmd);
  assert.ok(OW_REGISTER_COMMAND.includes(`${OW_ORIGIN}/api/register`));
  assert.ok(SURFACE.some((r) => r.path === "/api/register" && r.method === "POST"));
  assert.ok(SURFACE.some((r) => r.path === "/api/seal" && r.method === "POST"));
});

test("the figures are the ones the seal door enforces", () => {
  assert.ok(text.includes(`an account may make ${SEALS_PER_DAY.toLocaleString("en-US")} in any rolling day`));
  assert.ok(text.includes(`up to ${SEAL_CHECKS_PER_DAY.toLocaleString("en-US")} a day`));
  assert.ok(text.includes(`1 to ${LABEL_MAX} characters`));
  assert.ok(text.includes(`One seal an hour is 24 a day; an account may make ${SEALS_PER_DAY} in any rolling day, so one each five minutes, 288 a day, does not fit`));
  assert.ok(SEALS_PER_DAY < 288, "the page says one each five minutes does not fit; 288 a day would");
  assert.ok(SEALS_PER_DAY >= 24, "the page says one an hour fits");
});

test("the worked example is the adapter's line for a seal that exists", () => {
  assert.equal(OW_EXAMPLE_LINE, adapter.witnessLine(OW_EXAMPLE.log, OW_EXAMPLE.count, OW_EXAMPLE.head));
  assert.ok(HUMAN_OUTSIDE_WITNESS_HTML.includes(`<pre>${OW_EXAMPLE_LINE}</pre>`));
  assert.equal(OW_EXAMPLE.seal_id, 9737, "the example names the seal that was made");
  // The seal's hash, as the registry answered: sha-256 over the line as sent.
  assert.equal(createHash("sha256").update(OW_EXAMPLE_LINE, "utf8").digest("hex"), "c01354f8dd5531571856955013eafde5dfa9962d8245dfb43f611356ded77e71");
  assert.ok(text.includes(`It is seal ${OW_EXAMPLE.seal_id}, in the series at ${OW_EXAMPLE_SEALS_PATH}`));
  // The head is the sha-256 the research snapshot's manifest records for events.jsonl, and the count its rows.
  const manifest = JSON.parse(readFileSync(repo("exports/2026-10-06/manifest.json"), "utf8")) as { files: Record<string, { rows: number; sha256: string }> };
  assert.equal(OW_EXAMPLE.head, manifest.files["events.jsonl"].sha256);
  assert.equal(OW_EXAMPLE.count, manifest.files["events.jsonl"].rows);
});

test("the page names no site but this one, and every link is a path that exists", () => {
  const hosts = new Set([...HUMAN_OUTSIDE_WITNESS_HTML.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts], ["1f916.ai"]);
  const bare = [...HUMAN_OUTSIDE_WITNESS_HTML.replace(/<style>.*?<\/style>/s, "").matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|xyz|city))\b/g)].map((m) => m[1]);
  assert.equal(OW_CONTACT, "1f916.ai@gmail.com");
  assert.deepEqual([...new Set(bare)].sort(), ["1f916.ai", "gmail.com"].sort());
  assert.ok(!/fetch\(|XMLHttpRequest|<img|<iframe|<link|<script/.test(HUMAN_OUTSIDE_WITNESS_HTML), "the page loads and runs nothing");
  const links = [...HUMAN_OUTSIDE_WITNESS_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(links)].sort(), [OW_EVIDENCE_PATH, OW_EXAMPLE_SEALS_PATH, OW_SCRIPT_PATH].sort());
  assert.equal(OW_SCRIPT_PATH, `/source/1f916/${OW_SCRIPT_REPO_PATH}`);
  assert.ok(existsSync(repo(OW_SCRIPT_REPO_PATH)));
  assert.ok(SURFACE.some((r) => r.path === OW_EVIDENCE_PATH && r.method === "GET"));
  assert.ok(SURFACE.some((r) => r.path === "/api/seals" && r.method === "GET"));
});
