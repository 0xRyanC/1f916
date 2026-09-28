// Stamps in the format the certificate logs use (src/note.ts, and
// checkpointNote in src/checkpoint.ts, served at GET /api/checkpoint/note).
//
// The promise is that a tool which checks a transparency log can check this
// one, so the format must be exactly theirs. It is pinned here against a real
// one: GO_NOTE is a checkpoint signed by sum.golang.org, fetched 2026-09-28,
// and GO_VKEY is the key Go publishes for it. If verifyNote reads Go's note,
// and reads ours with the same code, ours is in Go's format.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   N1  leave the signature type byte out of the key id      -> "the key id is the format's, checked against Go's published key"
//   N2  sign the text without its final newline              -> "the registry's own stamp, as a note, verifies with its published verifier key"
//   N3  put the root in the note as hex                      -> "the text is three lines, each ended, with the root in base64"
//   N4  use a hyphen for the signature line's dash           -> "reads a checkpoint signed by sum.golang.org"
//   N5  accept a signature by any key of the right name      -> "a changed note, or another key, does not verify"
//   N6  sign a different size than the stored row's          -> "the note says what the stamp says: the same log, size and root"
//   N7  serve the newest stamp when another size was asked   -> "an earlier stamp is served by its size, and a size no stamp landed on is refused"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { checkpointBody, formatNote, noteKeyId, originOf, parseCheckpoint, parseNote, verifierKey, verifyNote, NOTE_KEY_NAME } from "../src/note.ts";
import { checkpointNote, latestCheckpoints, makeCheckpoints } from "../src/checkpoint.ts";
import { sealMemory, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const GO_VKEY = "sum.golang.org+033de0ae+Ac4zctda0e5eza+HJyk9SxEdh+s3Ux18htTTAD8OuAn8";
const GO_NOTE = Buffer.from(
  "Z28uc3VtIGRhdGFiYXNlIHRyZWUKNjU2NjQyNTgKV1ZWTlZEMnF4K2ZUcTMxemtqNlVBcXhUNVg2SHZHcGhHTStvOFRobmJzZz0KCuKAlCBzdW0uZ29sYW5nLm9yZyBBejNncmxpZ0ptZ1g3S0d5R1BLeWJ5a05UaDNWZ3NiTHZVdXZPd3JNNXpMVmx1bG1GcDJ3ZHZieE93NzQvZ2NOeFVSU2hYRXBiN1JYY3MzK0JZZmxZTit3MGdRPQo=",
  "base64",
).toString("utf8");

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
function registryKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { seed, pub, secret: `${b64u(seed)}.${b64u(pub)}` };
}

async function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0)`);
  const key = registryKey();
  const e = { ...env, REGISTRY_SEED: key.secret } as Env;
  const keeper = { id: 1, handle: "keeper" } as Citizen;
  const grow = async (n: number, tag: string) => {
    for (let i = 0; i < n; i++) await sealMemory(e, keeper, { hash: Buffer.from(`${tag}-${i}`.padEnd(32, ".")).toString("hex"), label: `${tag}${i}` });
  };
  return { env: e, db, key, grow };
}

test("reads a checkpoint signed by sum.golang.org", async () => {
  assert.equal(await verifyNote(GO_NOTE, GO_VKEY), true);
  const note = parseNote(GO_NOTE);
  assert.equal(note.body, "go.sum database tree\n65664258\nWVVNVD2qx+fTq31zkj6UAqxT5X6HvGphGM+o8Thnbsg=\n");
  assert.deepEqual(note.signatures.map((s) => [s.name, s.keyId, s.signature.length]), [["sum.golang.org", "033de0ae", 64]]);
  const cp = parseCheckpoint(note.body);
  assert.equal(cp.origin, "go.sum database tree");
  assert.equal(cp.treeSize, 65664258);
  assert.equal(cp.rootHex, Buffer.from("WVVNVD2qx+fTq31zkj6UAqxT5X6HvGphGM+o8Thnbsg=", "base64").toString("hex"));
  assert.deepEqual(cp.extensions, []);
});

test("the key id is the format's, checked against Go's published key", async () => {
  const goKey = Buffer.from("Ac4zctda0e5eza+HJyk9SxEdh+s3Ux18htTTAD8OuAn8", "base64");
  assert.equal(goKey[0], 1);
  assert.equal(Buffer.from(await noteKeyId("sum.golang.org", goKey.subarray(1))).toString("hex"), "033de0ae");
  assert.equal(await verifierKey("sum.golang.org", goKey.subarray(1)), GO_VKEY, "and the verifier key is rebuilt exactly as Go publishes it");
  await assert.rejects(noteKeyId("has space", goKey.subarray(1)), /key name/);
  await assert.rejects(noteKeyId("has+plus", goKey.subarray(1)), /key name/);
  await assert.rejects(noteKeyId("ok", goKey), /32 bytes/);
});

test("a changed note, or another key, does not verify", async () => {
  const bent = GO_NOTE.replace("65664258", "65664259");
  assert.equal(await verifyNote(bent, GO_VKEY), false, "one digit of the size");
  assert.equal(await verifyNote(GO_NOTE.replace("WVVN", "WVVM"), GO_VKEY), false, "one character of the root");
  // Another key under the same name: the id differs, so its signature is not even tried.
  const other = registryKey();
  const otherVkey = await verifierKey("sum.golang.org", other.pub);
  assert.equal(await verifyNote(GO_NOTE, otherVkey), false);
  // A verifier key whose id is not the id of its key is refused outright.
  await assert.rejects(verifyNote(GO_NOTE, GO_VKEY.replace("033de0ae", "033de0af")), /id is not the id of its key/);
  // A note signed by a key the reader did not name carries no weight, and is not an error.
  const mine = await verifierKey("1f916.ai", other.pub);
  assert.equal(await verifyNote(GO_NOTE, mine), false);
  // Shapes that are not notes.
  assert.throws(() => parseNote("no blank line\n"), /no blank line/);
  assert.throws(() => parseNote("text\n\n- sum.golang.org AAAAAAA=\n"), /signature line/, "a hyphen is not the format's dash");
  assert.throws(() => parseNote("text\n\n— name AAAAAAA=\n— torn"), /not ended|signature line/);
  assert.throws(() => parseCheckpoint("origin\n12\n"), /fewer than three lines/);
  assert.throws(() => parseCheckpoint("origin\n012\nWVVNVD2qx+fTq31zkj6UAqxT5X6HvGphGM+o8Thnbsg=\n"), /not a tree size/);
  assert.throws(() => parseCheckpoint("origin\n12\nAAAA\n"), /not 32 bytes/);
});

test("the text is three lines, each ended, with the root in base64", () => {
  const root = "59554d543daac7e7d3ab7d73923e9402ac53e57e87bc6a6118cfa8f138676ec8";
  assert.equal(checkpointBody("1f916.ai/identity_events", 21168, root), "1f916.ai/identity_events\n21168\nWVVNVD2qx+fTq31zkj6UAqxT5X6HvGphGM+o8Thnbsg=\n");
  assert.equal(checkpointBody("1f916.ai/ledger", 0, "00".repeat(32)), `1f916.ai/ledger\n0\n${Buffer.alloc(32).toString("base64")}\n`);
  assert.equal(originOf("identity_events"), "1f916.ai/identity_events");
  assert.equal(NOTE_KEY_NAME, "1f916.ai");
  assert.throws(() => checkpointBody("two words", 1, root), /one printable line/);
  assert.throws(() => checkpointBody("o", -1, root), /whole number/);
  assert.throws(() => checkpointBody("o", 1.5, root), /whole number/);
  assert.throws(() => checkpointBody("o", 1, root.slice(2)), /32 bytes/);
  assert.throws(() => checkpointBody("o", 1, root.toUpperCase()), /lowercase hex/);
  assert.throws(() => formatNote("no newline", "k", new Uint8Array(4), new Uint8Array(64)), /ends with a newline/);
});

test("the registry's own stamp, as a note, verifies with its published verifier key", async () => {
  const { env, key, grow } = await fixture();
  await grow(5, "a");
  await makeCheckpoints(env);
  const facts = (await latestCheckpoints(env)).note;
  assert.equal(facts.key_name, "1f916.ai");
  assert.equal(facts.verifier_key, await verifierKey("1f916.ai", key.pub));
  assert.deepEqual(facts.origins, { identity_events: "1f916.ai/identity_events", ledger: "1f916.ai/ledger" });
  for (const log of ["identity_events", "ledger"]) {
    const note = await checkpointNote(env, log, undefined);
    assert.equal(await verifyNote(note, facts.verifier_key), true, log);
    assert.ok(note.endsWith("\n"));
    assert.equal(note.split("\n\n").length, 2, "one blank line, between the text and the signature");
    assert.match(note, /\n\n— 1f916\.ai [A-Za-z0-9+/]+={0,2}\n$/);
    // The same stored row always yields the same bytes.
    assert.equal(await checkpointNote(env, log, undefined), note);
    // And Go's key does not vouch for ours.
    assert.equal(await verifyNote(note, GO_VKEY), false);
  }
});

test("the note says what the stamp says: the same log, size and root", async () => {
  const { env, grow } = await fixture();
  await grow(7, "b");
  await makeCheckpoints(env);
  const stamps = (await latestCheckpoints(env)).checkpoints as { log: string; tree_size: number; root: string }[];
  assert.equal(stamps.length, 2);
  for (const s of stamps) {
    const cp = parseCheckpoint(parseNote(await checkpointNote(env, s.log, undefined)).body);
    assert.deepEqual(cp, { origin: `1f916.ai/${s.log}`, treeSize: s.tree_size, rootHex: s.root, extensions: [] });
  }
  assert.equal(stamps.find((s) => s.log === "identity_events")!.tree_size, 7);
});

test("an earlier stamp is served by its size, and a size no stamp landed on is refused", async () => {
  const { env, grow } = await fixture();
  await grow(3, "c");
  await makeCheckpoints(env);
  const early = await checkpointNote(env, "identity_events", undefined);
  await grow(4, "d");
  await makeCheckpoints(env);
  const late = await checkpointNote(env, "identity_events", undefined);
  assert.equal(parseCheckpoint(parseNote(early).body).treeSize, 3);
  assert.equal(parseCheckpoint(parseNote(late).body).treeSize, 7);
  assert.equal(await checkpointNote(env, "identity_events", 3), early, "the earlier one, byte for byte, by its size");
  assert.equal(await checkpointNote(env, "identity_events", 7), late);
  await assert.rejects(checkpointNote(env, "identity_events", 5), /no checkpoint at tree_size=5/);
  await assert.rejects(checkpointNote(env, "posts", undefined), /log must be one of/);
  await assert.rejects(checkpointNote(env, null, undefined), /log must be one of/);
});

test("over HTTP: the note is served as plain text, byte for byte, and its parameters are checked", async () => {
  const { env, grow } = await fixture();
  await grow(2, "e");
  await makeCheckpoints(env);
  const get = (path: string) => worker.fetch(new Request(`https://1f916.ai${path}`), env);
  const res = await get("/api/checkpoint/note/identity_events");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  const served = await res.text();
  assert.equal(served, await checkpointNote(env, "identity_events", undefined));
  const stamp = (await (await get("/api/checkpoint")).json()) as { note: { verifier_key: string; url: string } };
  assert.equal(await verifyNote(served, stamp.note.verifier_key), true, "with the key the stamp's own endpoint publishes");
  assert.equal(stamp.note.url, "/api/checkpoint/note/<log>");
  assert.equal((await get("/api/checkpoint/note/identity_events?tree_size=2")).status, 200);
  assert.equal((await get("/api/checkpoint/note/ledger")).status, 200);
  assert.equal((await get("/api/checkpoint/note/identity_events?tree_size=1")).status, 404);
  assert.equal((await get("/api/checkpoint/note/posts")).status, 400, "a log that is not one of the two");
  assert.equal((await get("/api/checkpoint/note/identity_events?size=2")).status, 400, "an unknown parameter is refused");
  assert.equal((await get("/api/checkpoint/note/identity_events?tree_size=two")).status, 400);
});
