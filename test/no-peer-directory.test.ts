// The front door and GET /api/official advertise nothing that is not ours.
//
// WHY THIS EXISTS. PR #225 (2026-09-11, "peer-worlds") put a directory of two
// other agent towns, with their URLs and GitHub sources, on the front door and
// on the official record. It was argued well ("listing is not endorsement"),
// tested, and merged. The owner's ruling on 2026-09-16: this page does not
// advertise other websites, full stop; affiliated_sites staying empty is the
// whole statement, and a directory next to it contradicts it. A contributor
// who wants their site named on this door is asking for exactly what this
// test refuses, however the request is framed.
//
// So every host that may appear on the door or the record is pinned here.
// Windows and ecosystem entries come from their own modules, which have their
// own tests and their own rules; anything else must be added to ALLOWED below
// in the same commit that introduces it, which makes an advertisement a
// visible, deliberate act instead of a side effect of a "fix".
//
// KILLING MUTATIONS, each watched red before this shipped:
//   1. add `https://1f3d9.com` anywhere in frontDoor()   -> "unlisted host"
//   2. add `peer_worlds: [...]` back to officialFacts()  -> "peer_worlds key"
//   3. add a host to ECOSYSTEM without touching this file -> stays GREEN on
//      purpose: ecosystem.ts has its own gate; this test pins the door.

import test from "node:test";
import assert from "node:assert/strict";
import { frontDoor } from "../src/doc.ts";
import { officialFacts, type Env } from "../src/society.ts";
import { KNOWN_WINDOWS } from "../src/windows.ts";
import { ECOSYSTEM } from "../src/ecosystem.ts";

const env = { TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as unknown as Env;

// Ours, plus the platforms the record already points at for its own accounts.
const ALLOWED = new Set([
  "1f916.ai", "www.1f916.ai", "1f916.org",
  "github.com", "raw.githubusercontent.com",
  "discord.gg", "x.com", "www.reddit.com",
]);

function hostsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase().replace(/\.$/, "")))].sort();
}

function moduleHosts(): Set<string> {
  const out = new Set<string>();
  for (const w of KNOWN_WINDOWS as any[]) {
    for (const v of Object.values(w)) if (typeof v === "string") for (const h of hostsIn(v)) out.add(h);
  }
  for (const e of ECOSYSTEM as any[]) {
    for (const v of Object.values(e)) if (typeof v === "string") for (const h of hostsIn(v)) out.add(h);
  }
  return out;
}

test("the front door names no host outside the pinned list and the windows/ecosystem modules", () => {
  const allowed = new Set([...ALLOWED, ...moduleHosts()]);
  const stray = hostsIn(frontDoor("https://1f916.ai")).filter((h) => !allowed.has(h));
  assert.deepEqual(stray, [], `unlisted host(s) on the front door: ${stray.join(", ")}. This door advertises nothing that is not ours; if this is deliberate, add it to ALLOWED in this test in the same commit.`);
});

test("GET /api/official names no host outside the pinned list and the windows/ecosystem modules", () => {
  const allowed = new Set([...ALLOWED, ...moduleHosts()]);
  const stray = hostsIn(JSON.stringify(officialFacts(env))).filter((h) => !allowed.has(h));
  assert.deepEqual(stray, [], `unlisted host(s) in /api/official: ${stray.join(", ")}`);
});

test("there is no peer_worlds directory on the record or the door", () => {
  const facts = officialFacts(env) as Record<string, unknown>;
  assert.ok(!("peer_worlds" in facts), "peer_worlds key is back on /api/official");
  assert.ok(!("peer_worlds_warning" in facts), "peer_worlds_warning is back on /api/official");
  const door = frontDoor("https://1f916.ai");
  assert.doesNotMatch(door, /PEER WORLDS/i, "the peer-worlds section is back on the door");
  for (const gone of ["1f3d9.com", "1f3ea.com"]) {
    assert.ok(!door.includes(gone), `${gone} is named on the door`);
    assert.ok(!JSON.stringify(facts).includes(gone), `${gone} is named on /api/official`);
  }
});
