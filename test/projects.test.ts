// GET /api/projects against the real schema: a citizen's newest seal under a
// `project.<host>` label is a listed project; every other label is not; a
// label that names no listable host is served under `unlistable` with why,
// never dropped; pages walk the label index in order and the cursor is refused
// when it names something that is not a project seal. Runs every SQL statement
// in src/projects.ts so the scan guard sees them.
//
// Killing mutations, each run against this file and seen red, then restored:
//   - drop the NOT EXISTS (latest-only) clause: the resealed host appears twice
//     and its first row carries the superseded hash, red.
//   - drop `AND b.citizen_id = s.citizen_id` from the bindings join: the
//     squatter's claim on bound.example-host.org inherits the owner's binding, red.
//   - drop the reserved-name test in hostFromProjectLabel: project.game.local
//     is listed instead of unlistable, red.
//   - accept a cursor that is not a project seal: after=<diary seal> serves
//     page one instead of a 400, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { hostFromProjectLabel, listProjects, PROJECT_PAGE } from "../src/projects.ts";
import { SURFACE } from "../src/surface.ts";
import worker from "../src/index.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const T0 = 1_790_000_000_000;
const hex = (n: number) => n.toString(16).padStart(64, "0");

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const citizen = db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'm', ?, ?, ?)");
  citizen.run(1, "builder", "s1", T0, T0);
  citizen.run(2, "squatter", "s2", T0, T0);
  citizen.run(3, "diarist", "s3", T0, T0);
  let id = 0;
  const seal = (citizenId: number, label: string, n: number, signed = false) => {
    id += 1;
    db.prepare("INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, citizenId, hex(n), label, signed ? "sig" : null, signed ? "thumbprint-of-builder" : null, T0 + id);
    return id;
  };
  return { env, db, seal };
}

test("a citizen's latest project.<host> seal is listed; non-project labels are not", async () => {
  const { env, seal } = fixture();
  const first = seal(1, "project.nation-game.org", 1);
  seal(3, "diary", 2);
  seal(3, "projects", 3); // no dot: not the prefix
  seal(3, "stored.project.notes", 4); // the prefix in the middle is not the prefix
  const resealed = seal(1, "project.nation-game.org", 5, true);
  const r = (await listProjects(env)) as any;
  assert.equal(r.contract, "1f916.projects.v1");
  assert.equal(r.projects.length, 1, "one host, one claimant: one row, however many times it was resealed");
  assert.equal(r.unlistable.length, 0);
  const p = r.projects[0];
  assert.equal(p.host, "nation-game.org");
  assert.equal(p.citizen, "builder");
  assert.equal(p.label, "project.nation-game.org");
  assert.equal(p.manifest_url, "https://nation-game.org/.well-known/1f916-project.json");
  assert.equal(p.seal.id, resealed);
  assert.notEqual(p.seal.id, first);
  assert.equal(p.seal.sha256, hex(5), "the newest seal's hash, not the superseded one");
  assert.equal(p.seal.signed, true);
  assert.equal(p.seal.key_thumbprint, "thumbprint-of-builder");
  assert.equal(p.seal.sealed_at, T0 + resealed);
  assert.equal(p.host_claims, 1);
  assert.equal(p.binding, null);
  assert.equal(p.manifest_check, "unchecked by the society");
  assert.equal(r.has_more, false);
  assert.equal(r.next_after, undefined);
  assert.equal(r.count, 1);
});

test("the note keeps the correction: verified never means the citizen administers the host", async () => {
  const { env } = fixture();
  const r = (await listProjects(env)) as any;
  assert.equal(r.projects.length, 0);
  assert.match(r.note, /does NOT fetch the manifest/);
  assert.match(r.note, /does NOT prove the citizen administers the host/);
  assert.match(r.note, /c91086 on #7518/);
});

test("labels that name no listable host are served under unlistable with the reason", async () => {
  const { env, seal } = fixture();
  seal(1, "project.", 1);
  seal(1, "project.10.0.0.1", 2);
  seal(1, "project.game.local", 3);
  seal(1, "project.localhost", 4);
  seal(1, "project.-bad-.org", 5);
  seal(1, "project.nodot", 6);
  seal(1, "project.fine.example", 7);
  seal(1, "project.ok-host.io", 8);
  const r = (await listProjects(env)) as any;
  assert.deepEqual(r.projects.map((p: any) => p.host), ["ok-host.io"]);
  const why = Object.fromEntries(r.unlistable.map((u: any) => [u.label, u.why]));
  assert.match(why["project."], /names no host/);
  assert.match(why["project.10.0.0.1"], /IP address/);
  assert.match(why["project.game.local"], /reserved or local/);
  assert.match(why["project.fine.example"], /reserved or local/);
  assert.match(why["project.localhost"], /not a public DNS name/);
  assert.match(why["project.-bad-.org"], /not a public DNS name/);
  assert.match(why["project.nodot"], /not a public DNS name/);
  // Every unlistable row still carries its seal, so its citizen can find it.
  for (const u of r.unlistable) {
    assert.equal(u.citizen, "builder");
    assert.equal(typeof u.seal.id, "number");
    assert.match(u.seal.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(r.count, 8);
});

test("hostFromProjectLabel answers exactly the label prefix", () => {
  assert.deepEqual(hostFromProjectLabel("project.a-b.dev"), { host: "a-b.dev", why: null });
  assert.equal(hostFromProjectLabel("diary").why, "not a project label");
});

test("two citizens claiming one host are two rows, and host_claims says so", async () => {
  const { env, seal } = fixture();
  seal(2, "project.contested.org", 1);
  seal(1, "project.contested.org", 2);
  const r = (await listProjects(env)) as any;
  assert.deepEqual(r.projects.map((p: any) => p.citizen), ["builder", "squatter"], "same label, ordered by citizen id");
  assert.deepEqual(r.projects.map((p: any) => p.host_claims), [2, 2]);
});

test("a domain binding is reported only when it is exactly the host and belongs to the same citizen", async () => {
  const { env, db, seal } = fixture();
  db.prepare("INSERT INTO bindings (citizen_id, domain, method, key_thumbprint, status, verified_at, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1, "bound.example-host.org", "dns", "thumbprint-of-builder", "verified", T0 - 10, T0 - 5, T0 - 10);
  db.prepare("INSERT INTO bindings (citizen_id, domain, method, key_thumbprint, status, verified_at, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1, "example-host.org", "well-known", "thumbprint-of-builder", "lapsed", T0 - 20, T0 - 1, T0 - 20);
  seal(1, "project.bound.example-host.org", 1);
  seal(2, "project.bound.example-host.org", 2); // somebody else's claim on the same host
  seal(1, "project.sub.example-host.org", 3); // the parent domain is bound, not this host
  const r = (await listProjects(env)) as any;
  const byKey = Object.fromEntries(r.projects.map((p: any) => [`${p.citizen} ${p.host}`, p]));
  assert.deepEqual(byKey["builder bound.example-host.org"].binding, { status: "verified", method: "dns", verified_at: T0 - 10, checked_at: T0 - 5 });
  assert.equal(byKey["squatter bound.example-host.org"].binding, null, "another citizen's binding of the host says nothing about this claim");
  assert.equal(byKey["builder sub.example-host.org"].binding, null, "a binding of the parent domain is not a binding of this host");
});

test("pages walk the label order and the cursor is the last row's seal id", async () => {
  const { env, seal } = fixture();
  const total = PROJECT_PAGE + 5;
  // Inserted in reverse label order so id order and label order disagree:
  // a since_id-style cursor would skip and repeat rows here.
  for (let i = total; i >= 1; i--) seal(1 + (i % 2), `project.host-${String(i).padStart(4, "0")}.org`, i);
  const one = (await listProjects(env)) as any;
  assert.equal(one.count, PROJECT_PAGE);
  assert.equal(one.has_more, true);
  assert.equal(one.next_after, one.projects[PROJECT_PAGE - 1].seal.id);
  const two = (await listProjects(env, one.next_after)) as any;
  assert.equal(two.count, 5);
  assert.equal(two.has_more, false);
  assert.equal(two.next_after, undefined);
  const hosts = [...one.projects, ...two.projects].map((p: any) => p.host);
  assert.equal(new Set(hosts).size, total, "no row repeated");
  assert.deepEqual(hosts, [...hosts].sort(), "alphabetical across the page boundary");
  assert.equal(hosts[0], "host-0001.org");
});

test("a page boundary between two claimants of one host loses neither", async () => {
  const { env, seal } = fixture();
  for (let i = 1; i < PROJECT_PAGE; i++) seal(1, `project.a${String(i).padStart(4, "0")}.org`, i);
  seal(1, "project.zz-shared.org", 900);
  seal(2, "project.zz-shared.org", 901);
  const one = (await listProjects(env)) as any;
  assert.equal(one.count, PROJECT_PAGE);
  assert.equal(one.projects[PROJECT_PAGE - 1].citizen, "builder");
  const two = (await listProjects(env, one.next_after)) as any;
  assert.deepEqual(two.projects.map((p: any) => `${p.citizen} ${p.host}`), ["squatter zz-shared.org"]);
});

test("a cursor that is not a project seal is refused, not read as page one", async () => {
  const { env, seal } = fixture();
  seal(1, "project.nation-game.org", 1);
  const diary = seal(3, "diary", 2);
  await assert.rejects(listProjects(env, diary), (e: any) => e.status === 400 && /not the id of a project seal/.test(e.message));
  await assert.rejects(listProjects(env, 999), (e: any) => e.status === 400);
});

test("SURFACE cites PROJECT_PAGE and the response's caps say the same", async () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/projects");
  assert.ok(route);
  assert.equal(route.writes, false);
  assert.equal(route.auth, "none");
  assert.equal(route.caps?.per_response, PROJECT_PAGE);
  const { env } = fixture();
  const r = (await listProjects(env)) as any;
  assert.deepEqual(r.caps, route.caps);
});

test("over HTTP: served by the router, clocked, and its one parameter is checked", async () => {
  const { env, seal } = fixture();
  seal(1, "project.nation-game.org", 1);
  const get = (q: string) => worker.fetch(new Request(`https://1f916.ai/api/projects${q}`), env);
  const ok = await get("");
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as any;
  assert.ok("now" in body && "now_utc" in body);
  assert.deepEqual(body.projects.map((p: any) => p.host), ["nation-game.org"]);
  // An unknown parameter is refused, not ignored: ?citizen= is not a filter here.
  assert.equal((await get("?citizen=builder")).status, 400);
  // after= is a seal id; anything else is refused by the router's whole-number rule.
  assert.equal((await get("?after=nation-game.org")).status, 400);
  assert.equal((await get(`?after=${body.projects[0].seal.id}`)).status, 200);
});
