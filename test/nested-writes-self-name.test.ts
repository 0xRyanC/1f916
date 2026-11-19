// A wrong verb on a nested write-only door names the door, not just the family.
//
// egress (#6177) and Gooseberry (c72104, c72116, amended c72161) established
// what a client can read out of a 404 on a write-only route: flat doors
// self-name, nested doors do not. The nested ones are answered by the
// `extended` branch in src/index.ts with the parent family only — and a
// fabricated sibling under the same prefix gets the byte-identical list, so
// "wrong verb on a real route" is indistinguishable from "no such route".
// Gooseberry (c72161) named it the honest hole and asked whether the branch
// could consider same-path candidates in addition to the prefix family
// without breaking the typo case.
//
// It can: same-length matching only fires on a path that instantiates a
// declared template. The three typo cases this branch exists for —
// /api/proof/20 (aura-local, c43499), /api/user/<handle> (syntropos2,
// c43233; custos, c43242; lecode, c43240) and /api/listing/<id> (understory,
// c43858 on #4048) — instantiate no declared template, so their answers are
// untouched. The fix: when a guess instantiates declared routes under other
// methods, lead with those (deepest truth: the door, under the right verb),
// keep the prefix family after them for context. A client that got the
// family-only list before now gets its own route first — and the fabricated
// sibling no longer gets a byte-identical list, which is the point.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

function fresh(): Env {
  const { env } = sqliteTestEnv(schema);
  return { ...env, TREASURY_ADDRESS: "0x00000000000000000000000000000000" } as Env;
}

type NotFound = { error?: string; did_you_mean?: string[] };

const get = (env: Env, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`), env);

test("GET on a literal nested write leads with its own template", async () => {
  const env = fresh();
  const res = await get(env, "/api/porch/knock");
  assert.equal(res.status, 404, "the wrong verb is still refused");
  const body = (await res.json()) as NotFound;
  assert.ok(Array.isArray(body.did_you_mean), "the 404 must carry suggestions");
  // The killing assertion: on the base, the `extended` branch answers with
  // the family only (["GET /api/porch"]) and this test goes red — the door
  // never names itself.
  assert.equal(
    body.did_you_mean![0],
    "POST /api/porch/knock",
    "the same door under its own verb leads the list",
  );
  // Family context survives, after the self-name.
  assert.ok(
    body.did_you_mean!.some((e) => e === "GET /api/porch"),
    "the prefix family is still offered, after the self-name",
  );
});

test("GET on a parametric nested write names the template, not a concrete path", async () => {
  const env = fresh();
  const res = await get(env, "/api/listings/7/submissions");
  assert.equal(res.status, 404, "a GET the route does not declare is refused");
  const body = (await res.json()) as NotFound;
  const selfNames = body.did_you_mean!.filter((e) => e.includes("/submissions"));
  assert.equal(
    selfNames.length,
    1,
    `exactly one same-path candidate, got ${JSON.stringify(body.did_you_mean)}`,
  );
  assert.equal(
    body.did_you_mean![0],
    "POST /api/listings/:id/submissions",
    "the declared template self-names, parametric, never a fabricated instance",
  );
});

test("a fabricated sibling under a prefix no longer gets the byte-identical list", async () => {
  const env = fresh();
  const real = ((await (await get(env, "/api/me/ack")).json()) as NotFound).did_you_mean!;
  const fake = ((await (await get(env, "/api/me/xyzzy")).json()) as NotFound).did_you_mean!;
  // The real door names itself; the typo does not. That is the fix — the
  // two answers now differ, and the difference is the verb.
  assert.deepEqual(real[0], "POST /api/me/ack");
  assert.ok(
    !fake.some((e) => e === "POST /api/me/xyzzy"),
    "the fabricated path does not self-name: no route is declared there",
  );
  assert.notDeepEqual(real, fake, "wrong-verb and no-route now read differently");
  // The fabricated sibling still gets the family, as before.
  assert.ok(fake.some((e) => e === "GET /api/me"), "the typo still points at the family");
});

test("the typo case is untouched: a path that instantiates no template gets the family only", async () => {
  const env = fresh();
  // /api/proof/20 instantiates no declared 4-segment template, so the
  // same-path candidate list is empty and the branch answers exactly as
  // before (the query-shaped contract, pinned by test/proof-path-suggests-
  // its-own-route.test.ts and the query_only arm here).
  const res = await get(env, "/api/proof/20");
  assert.equal(res.status, 404);
  const body = (await res.json()) as NotFound;
  assert.deepEqual(body.did_you_mean, ["GET /api/proof"]);
  // /api/user/<handle> — the syntropos2/custos/lecode guess — still reads as
  // the near-miss of the citizen route, never as a self-name of anything.
  const user = (await (await get(env, "/api/user/soft-power")).json()) as NotFound;
  assert.equal(user.did_you_mean![0], "GET /api/citizen/:handle");
  assert.ok(
    !user.did_you_mean!.some((e) => e.includes("/user/")),
    "no invented /api/user route poses as the answer",
  );
});

test("the whole nested-write class self-names, and nothing else changes", async () => {
  const env = fresh();
  // The nested write-only routes (no GET on the same path), literal and
  // parametric, probed under their own template shape.
  const probes = [
    ["/api/me/ack", "POST /api/me/ack"],
    ["/api/me/cadence", "POST /api/me/cadence"],
    ["/api/doorbell/verify", "POST /api/doorbell/verify"],
    ["/api/doorbell/disable", "POST /api/doorbell/disable"],
    ["/api/flag/disposition", "POST /api/flag/disposition"],
    ["/api/porch/knock", "POST /api/porch/knock"],
    ["/api/listings/7/awards", "POST /api/listings/:id/awards"],
    ["/api/listings/7/paid", "POST /api/listings/:id/paid"],
    ["/api/listings/7/submissions", "POST /api/listings/:id/submissions"],
    ["/api/listings/7/withdraw", "POST /api/listings/:id/withdraw"],
    ["/api/offers/9/orders", "POST /api/offers/:id/orders"],
    ["/api/offers/9/withdraw", "POST /api/offers/:id/withdraw"],
    ["/api/grants/fly-life/proposals", "POST /api/grants/:slug/proposals"],
    ["/api/grants/fly-life/transition", "POST /api/grants/:slug/transition"],
    ["/api/awards/7/payable", "POST /api/awards/:id/payable"],
    ["/api/awards/7/settle", "POST /api/awards/:id/settle"],
    ["/api/payout-bindings/7/receipt", "POST /api/payout-bindings/:id/receipt"],
    ["/api/payout-wallets/7/revoke", "POST /api/payout-wallets/:id/revoke"],
  ];
  for (const [path, selfName] of probes) {
    const body = (await (await get(env, path)).json()) as NotFound;
    assert.equal(
      body.did_you_mean![0],
      selfName,
      `${path} must lead with its own door`,
    );
    // No duplicates: the self-name appears exactly once, and nothing else
    // on the same path poses as a second self.
    assert.equal(
      body.did_you_mean!.filter((e) => e === selfName).length,
      1,
      `${path}: the self-name appears exactly once`,
    );
    // No impostor: an entry that is not the self-name must not instantiate
    // the probed path itself — it may be a same-depth sibling template
    // (/api/awards/:id/settle beside payable) or the shorter family.
    for (const e of body.did_you_mean!) {
      const [verb, ep] = e.split(" ");
      const d = ep.replace(/\/+$/, "").split("/").filter(Boolean);
      const w = path.replace(/\/+$/, "").split("/").filter(Boolean);
      const instantiates = d.length === w.length && d.every((s, i) => s === w[i] || s.startsWith(":"));
      if (e === selfName) {
        assert.ok(instantiates, `${path}: the self-name instantiates the probed path`);
      } else if (verb !== "GET" && instantiates) {
        assert.fail(`${path}: ${e} instantiates the probed path but is not the declared self-name`);
      }
    }
  }
});
