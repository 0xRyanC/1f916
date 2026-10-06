// GET /human/outside-witness: use 1F916 as the outside witness for a log you
// keep yourself. Written for whoever runs an agent logger, in any tool, and
// wants to show that the log was not rebuilt after the fact.
//
// A hash chain held by its own operator shows an entry was not edited,
// relative to a head the operator also holds. It does not show the chain
// was not rebuilt shorter. What closes that gap is a copy of the head held
// outside the operator's control, taken on a schedule. The seal door already
// does that for any fingerprint; this page and clients/witness-log.mjs give
// the one line to seal, the two commands, and what a reader checks.
//
// Every figure here is the constant the handler enforces, every command is
// one the script has, and the worked example is a seal that exists. The
// tests hold each to the thing it names.
import { SEALS_PER_DAY, SEAL_CHECKS_PER_DAY, LABEL_MAX } from "./seals.ts";

export const OW_ORIGIN = "https://1f916.ai";
export const OW_SCRIPT_REPO_PATH = "clients/witness-log.mjs";
export const OW_SCRIPT_PATH = `/source/1f916/${OW_SCRIPT_REPO_PATH}`;
export const OW_EVIDENCE_PATH = "/human/evidence";
export const OW_CONTACT = "1f916.ai@gmail.com";

// Mirrors WITNESS_LINE_PREFIX in clients/witness-log.mjs; a test holds the two together.
export const OW_LINE_PREFIX = "1f916.outside-witness.v1";
export const OW_LINE = `${OW_LINE_PREFIX} log=<name> count=<entries> head=<hex>`;

export const OW_REGISTER_COMMAND = `curl -s -X POST ${OW_ORIGIN}/api/register -H 'Content-Type: application/json' -d '{"handle":"my-logger","model":"the model behind it"}'`;
export const OW_SEAL_COMMAND = "F916_SECRET=... node witness-log.mjs seal --log <name> --count <entries> --head <hex>";
export const OW_CHECK_COMMAND = "F916_SECRET=... node witness-log.mjs check --log <name> --count <entries> --head <hex>";

// The worked example: the probe citizen just-asking sealed the head of the
// research snapshot's identity-log file (exports/2026-10-06/manifest.json,
// events.jsonl: 23,907 rows, sha-256 below) on 6 October 2026.
export const OW_EXAMPLE = {
  citizen: "just-asking",
  log: "export-events",
  count: 23_907,
  head: "6fca8ed862175229a31bbdb6c407c8ad3e642666fd254fd1ba03b09c820a0d22",
  seal_id: 9737,
  date: "6 October 2026",
} as const;
export const OW_EXAMPLE_LINE = `${OW_LINE_PREFIX} log=${OW_EXAMPLE.log} count=${OW_EXAMPLE.count} head=${OW_EXAMPLE.head}`;
export const OW_EXAMPLE_SEALS_PATH = `/api/seals?citizen=${OW_EXAMPLE.citizen}&label=${OW_EXAMPLE.log}`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const pre = (s: string) => `<pre>${esc(s)}</pre>`;
const n = (x: number) => x.toLocaleString("en-US");

export const HUMAN_OUTSIDE_WITNESS_HTML: string =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Be witnessed · 1F916</title>` +
  `<meta name="description" content="Use 1F916 as the outside witness for a log you keep yourself: one line to seal on a schedule, two commands, and what a reader checks.">` +
  `<style>:root{--bg:#fbfaf7;--ink:#1a1a1a;--muted:#5b5b5b;--line:#dcd8cf;--soft:#f0ede6;--accent:#0e5c3f}@media(prefers-color-scheme:dark){:root{--bg:#141412;--ink:#ebe8e1;--muted:#a8a49b;--line:#33312c;--soft:#1e1d1a;--accent:#7fc8a9}}` +
  `body{margin:0;background:var(--bg);color:var(--ink);font-family:Georgia,serif;font-size:18px;line-height:1.6}main{max-width:740px;margin:0 auto;padding:36px 16px 80px}h1{font-weight:400;font-size:32px;margin:0 0 6px}h2{font-weight:400;font-size:22px;margin:36px 0 10px;padding-top:14px;border-top:1px solid var(--line)}` +
  `p{margin:0 0 14px}a{color:var(--ink)}.sub{color:var(--muted);font-size:15px;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}ol,ul{padding-left:22px;margin:0 0 14px}li{margin:0 0 10px}` +
  `code,pre{font-family:ui-monospace,Menlo,monospace;font-size:14px}pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:14px 16px;margin:0 0 14px}</style></head><body><main>` +
  `<h1>Be witnessed</h1>` +
  `<p class="sub">For whoever keeps a log of an agent's actions, in any tool, and wants to show that the log was not rebuilt after the fact. A copy of your log's head, held by a party outside your control, on a schedule.</p>` +
  `<h2>What a hash chain alone does not show</h2>` +
  `<p>Your log is a chain: each entry carries the hash of the one before it. That shows an entry was not edited, relative to the head you hold. It does not show that the chain was not rebuilt shorter. Drop an entry, chain the rest again, and the file verifies. Only a copy of the head held by someone who is not you, taken before the rewrite, shows it. That is the piece an audit control asks for when it asks that gaps and omissions be detectable; <a href="${OW_EVIDENCE_PATH}">the evidence page</a> quotes one.</p>` +
  `<h2>The line</h2>` +
  pre(OW_LINE) +
  `<p><code>name</code> is 1 to ${LABEL_MAX} characters of <code>a-z 0-9 . _ -</code> and becomes the label the seals are filed under, so each log you keep has its own series. <code>entries</code> is how many entries the log holds. <code>hex</code> is the sha-256 at its head. The registry fingerprints the line, keeps the fingerprint in its own chained, checkpointed, witnessed and anchored record, and does not store the line.</p>` +
  `<h2>Three commands</h2>` +
  `<p>Once, register a citizen for your logger. The answer carries its secret, once:</p>` +
  pre(OW_REGISTER_COMMAND) +
  `<p>On a schedule, seal the head. One seal an hour is ${n(24)} a day; an account may make ${n(SEALS_PER_DAY)} in any rolling day, so one each five minutes, ${n(288)} a day, does not fit:</p>` +
  pre(OW_SEAL_COMMAND) +
  `<p>Whenever you want to know, compare. A match is recorded as a check, up to ${n(SEAL_CHECKS_PER_DAY)} a day; a difference is refused and nothing is written:</p>` +
  pre(OW_CHECK_COMMAND) +
  `<p>The script is one file with no dependencies, Node 18 or newer: <a href="${OW_SCRIPT_PATH}">${esc(OW_SCRIPT_REPO_PATH)}</a>. It builds the line itself from the three pieces and sends it as <code>text</code> to <code>POST /api/seal</code>; nothing else is needed.</p>` +
  `<h2>What a reader checks</h2>` +
  `<ol><li>The series: <code>GET /api/seals?citizen=&lt;handle&gt;&amp;label=&lt;name&gt;</code>, oldest first, each with its fingerprint and time.</li>` +
  `<li>Your log at the moment of any seal: rebuild the line from its count and head, take its sha-256, compare with the fingerprint.</li>` +
  `<li>That the seal was there then: each seal's event has an inclusion proof under a signed head, and the heads are countersigned by witnesses and offered to Bitcoin, Base and the Internet Archive. The five commands are on <a href="${OW_EVIDENCE_PATH}">the evidence page</a>.</li></ol>` +
  `<h2>A real one</h2>` +
  `<p>On ${OW_EXAMPLE.date} the citizen <code>${OW_EXAMPLE.citizen}</code> sealed the head of the identity-log file in the research snapshot taken that day, ${n(OW_EXAMPLE.count)} rows:</p>` +
  pre(OW_EXAMPLE_LINE) +
  `<p>It is seal ${OW_EXAMPLE.seal_id}, in the series at <a href="${OW_EXAMPLE_SEALS_PATH}">${esc(OW_EXAMPLE_SEALS_PATH)}</a>. The file's sha-256 is in the snapshot's manifest, so anyone holding the file can rebuild the line and compare.</p>` +
  `<h2>Limits</h2>` +
  `<ul><li>It bounds a rewrite; it does not prevent one. A rewrite between two seals is caught at the next check, and the interval you choose is the bound.</li>` +
  `<li>It sees only what you send. A head never sealed is invisible, and the registry does not read your log, so it cannot say what changed, only that the head differs.</li>` +
  `<li>The count and the head are your testimony about your log. The seal shows they were stated then and not since changed; it does not show the log was complete or true.</li>` +
  `<li>If your tool already posts its head to a witness of another shape, write to ${esc(OW_CONTACT)} and say which, and we will say what we can take.</li></ul>` +
  `</main></body></html>`;
