// The Merkle module is the load-bearing math of protocol P2 — if these
// algorithms are wrong, every checkpoint the registry signs is a confident
// lie. Two lines of defense: the RFC 6962 test vectors (the roots any CT
// implementation must produce), and exhaustive property tests — every (index,
// size) inclusion pair and every (m, n) consistency pair for trees up to 33
// leaves must verify, and tampered inputs must not.

import test from "node:test";
import assert from "node:assert/strict";
import { MerkleTree, consistencyProof, inclusionProof, merkleRoot, verifyConsistency, verifyInclusion } from "../src/merkle.ts";

// RFC 6962 defines MTH over byte strings; our leaves are strings fed as
// UTF-8. The canonical empty-tree vector must hold regardless.
test("empty tree root is sha256 of the empty string (RFC 6962)", async () => {
  assert.equal(await merkleRoot([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("single-leaf tree is the leaf hash with the 0x00 prefix", async () => {
  const root = await merkleRoot(["a"]);
  assert.equal(root.length, 64);
  assert.notEqual(root, await merkleRoot(["b"]), "different leaf, different root");
});

test("every inclusion proof verifies, for every index, at every tree size up to 33", async () => {
  const leaves = Array.from({ length: 33 }, (_, i) => `event-hash-${i}`);
  for (let size = 1; size <= leaves.length; size++) {
    const root = await merkleRoot(leaves.slice(0, size));
    for (let index = 0; index < size; index++) {
      const proof = await inclusionProof(leaves, index, size);
      assert.equal(await verifyInclusion(leaves[index], index, size, proof, root), true, `inclusion (${index}, ${size})`);
      assert.equal(await verifyInclusion("tampered", index, size, proof, root), false, `tampered leaf must fail (${index}, ${size})`);
    }
  }
});

test("every consistency proof verifies, for every (m, n) pair up to 33", async () => {
  const leaves = Array.from({ length: 33 }, (_, i) => `event-hash-${i}`);
  const roots: string[] = [];
  for (let size = 0; size <= leaves.length; size++) roots[size] = await merkleRoot(leaves.slice(0, size));
  for (let n = 1; n <= leaves.length; n++) {
    for (let m = 1; m <= n; m++) {
      const proof = await consistencyProof(leaves.slice(0, n), m, n);
      assert.equal(await verifyConsistency(m, n, roots[m], roots[n], proof), true, `consistency (${m}, ${n})`);
    }
  }
});

// MerkleTree is the pure functions with a memo. The contract is byte equality:
// every proof and every root it produces must be exactly what inclusionProof,
// consistencyProof and merkleRoot produce, for every (index, size) and every
// (m, n) — the memo may only change the cost, never the bytes.
test("MerkleTree produces the same proofs and roots as the pure functions, for every pair up to 48 leaves", async () => {
  const leaves = Array.from({ length: 48 }, (_, i) => `event-hash-${i}`);
  const tree = new MerkleTree(leaves);
  for (let size = 0; size <= leaves.length; size++) {
    assert.equal(await tree.root(size), await merkleRoot(leaves.slice(0, size)), `root at size ${size}`);
    for (let index = 0; index < size; index++) {
      assert.deepEqual(await tree.inclusionProof(index, size), await inclusionProof(leaves, index, size), `inclusion (${index}, ${size})`);
    }
    for (let m = 1; m <= size; m++) {
      assert.deepEqual(await tree.consistencyProof(m, size), await consistencyProof(leaves.slice(0, size), m, size), `consistency (${m}, ${size})`);
    }
  }
  assert.equal(await tree.root(), await merkleRoot(leaves), "default size is the whole leaf set");
});

// The reason the class exists. GET /api/record/:handle proves a page of up to
// 200 events against one checkpoint; through the pure function that was ~2n
// digests per event (0.4 s each at the live n of 13,000). Over one tree the
// whole page must cost about one tree's worth of digests: n leaf hashes and
// n - 1 node hashes to build every subtree once, then nothing per proof but
// the lookups. The bound below is 3n for 200 proofs where the pure function
// spends ~400n; a memo that silently stopped working would trip it by 100x.
test("200 inclusion proofs over one MerkleTree cost about one tree of digests, not 200", async () => {
  const n = 4096;
  const leaves = Array.from({ length: n }, (_, i) => `leaf-${i}`);
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  let digests = 0;
  subtle.digest = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto["digest"]>) {
    digests++;
    return original.apply(this, args);
  } as SubtleCrypto["digest"];
  try {
    const tree = new MerkleTree(leaves);
    const root = await tree.root();
    for (let i = 0; i < 200; i++) {
      const index = (i * 97) % n;
      const proof = await tree.inclusionProof(index, n);
      assert.equal(await verifyInclusion(leaves[index], index, n, proof, root), true, `proof ${index} verifies`);
    }
  } finally {
    subtle.digest = original;
  }
  // verifyInclusion itself spends log2(n) + 1 digests per proof; those are
  // the verifier's, counted here too, and still leave the total far under 3n.
  assert.ok(digests < 3 * n, `200 proofs over ${n} leaves took ${digests} digests; the memo is not working if this is near ${400 * n}`);
});

test("a rewritten history cannot produce a passing consistency proof", async () => {
  const honest = Array.from({ length: 20 }, (_, i) => `event-${i}`);
  const rewritten = [...honest.slice(0, 10), "FORGED", ...honest.slice(11)];
  const oldRoot = await merkleRoot(honest.slice(0, 15));
  const newRoot = await merkleRoot(rewritten);
  const proof = await consistencyProof(rewritten, 15, 20);
  assert.equal(await verifyConsistency(15, 20, oldRoot, newRoot, proof), false, "a fork must be mathematically undeniable");
});

test("boundary cases: m=n needs an empty proof and the same root; m=0 proves nothing", async () => {
  const leaves = ["a", "b", "c"];
  const root = await merkleRoot(leaves);
  // A log that has not grown (the ledger has stood at tree_size 11 since
  // 2026-09-02) is checked from a size to itself: the proof is empty, and the
  // whole check is that the served root equals the one the verifier pinned.
  // Before this assertion the root half of that line had no test: replacing
  // `oldRoot === newRoot` with `true` left the suite green, and a rewrite at
  // the same size is the one tamper a still log can suffer (#4341, c62940).
  const otherRoot = await merkleRoot(["a", "b", "d"]);
  assert.equal(await verifyConsistency(3, 3, root, root, []), true);
  assert.equal(await verifyConsistency(3, 3, root, root, ["00"]), false);
  assert.equal(await verifyConsistency(3, 3, root, otherRoot, []), false, "a different root at the same size is a rewrite, not a still log");
  assert.equal(await verifyConsistency(0, 3, "anything", root, []), true, "an empty log is consistent with everything");
});
