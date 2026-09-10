/**
 * The tree is the only place where an off-chain mistake becomes an on-chain one: a root that does
 * not match the proofs handed out simply locks an epoch until its window expires. So these run over
 * awkward shapes rather than a happy path, odd leaf counts especially, because an odd node is the
 * one that gets carried up instead of paired.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { buildEpochTree, leafHash, verifyProof, type Entitlement } from "../src/lib/merkle";

function sample(n: number): Entitlement[] {
  return Array.from({ length: n }, (_, i) => ({
    wallet: Keypair.generate().publicKey.toBase58(),
    amount: BigInt((i + 1) * 1_000),
  }));
}

test("one claimant is its own root and needs no proof", () => {
  const [only] = sample(1);
  const tree = buildEpochTree([only], 0n);

  assert.equal(tree.depth, 0);
  assert.deepEqual(tree.proofFor(only.wallet), []);
  assert.ok(tree.root.equals(leafHash(0n, only.wallet, only.amount)));
  assert.ok(verifyProof(tree.root, 0n, only.wallet, only.amount, []));
});

test("every claimant verifies, at every awkward size", () => {
  for (const n of [1, 2, 3, 5, 7, 8, 9, 33, 100, 257]) {
    const entries = sample(n);
    const tree = buildEpochTree(entries, 0n);

    for (const e of entries) {
      assert.ok(
        verifyProof(tree.root, 0n, e.wallet, e.amount, tree.proofFor(e.wallet)),
        `size ${n}: ${e.wallet} did not verify`,
      );
    }
    assert.equal(tree.entries.length, n);
    assert.equal(tree.total, entries.reduce((s, e) => s + e.amount, 0n));
  }
});

test("the depth stays inside what the program will walk", () => {
  // 2^17 leaves is far past any epoch we expect, and still 7 levels short of the cap.
  const tree = buildEpochTree(sample(4_096), 0n);
  assert.ok(tree.depth <= 24, `depth ${tree.depth}`);
  assert.equal(tree.depth, 12);
});

test("input order does not change the root", () => {
  const entries = sample(37);
  const forwards = buildEpochTree(entries, 7n);
  const backwards = buildEpochTree([...entries].reverse(), 7n);
  const shuffled = buildEpochTree([...entries].sort(() => Math.random() - 0.5), 7n);

  assert.ok(forwards.root.equals(backwards.root));
  assert.ok(forwards.root.equals(shuffled.root));
});

test("a proof only works for the exact wallet and the exact amount", () => {
  const entries = sample(16);
  const tree = buildEpochTree(entries, 0n);
  const [mine, theirs] = entries;
  const proof = tree.proofFor(mine.wallet);

  assert.ok(verifyProof(tree.root, 0n, mine.wallet, mine.amount, proof));
  assert.ok(!verifyProof(tree.root, 0n, mine.wallet, mine.amount + 1n, proof), "amount was mutable");
  assert.ok(!verifyProof(tree.root, 0n, theirs.wallet, mine.amount, proof), "wallet was mutable");
  assert.ok(!verifyProof(tree.root, 0n, mine.wallet, mine.amount, proof.slice(1)), "proof was trimmable");
});

test("a sibling hash cannot be passed off as a leaf", () => {
  // The point of the 0x00 / 0x01 prefixes. An internal node is a real 32-byte value inside the
  // tree, so without domain separation someone could try to claim it as if it were their leaf.
  const entries = sample(4);
  const tree = buildEpochTree(entries, 0n);
  const internal = tree.proofFor(entries[0].wallet)[1];

  for (const e of entries) {
    assert.ok(!leafHash(0n, e.wallet, e.amount).equals(internal));
  }
});

test("an epoch refuses the shapes that would pay twice or pay nothing", () => {
  const [a, b] = sample(2);

  assert.throws(() => buildEpochTree([], 0n), /at least one claimant/);
  assert.throws(() => buildEpochTree([a, { ...a, amount: 5n }], 0n), /appears twice/);
  assert.throws(() => buildEpochTree([a, { ...b, amount: 0n }], 0n), /not a positive amount/);
  assert.throws(() => buildEpochTree([{ ...a, amount: -1n }], 0n), /not a positive amount/);
});

test("amountFor answers for a member and stays quiet for a stranger", () => {
  const entries = sample(8);
  const tree = buildEpochTree(entries, 0n);
  const stranger = Keypair.generate().publicKey.toBase58();

  assert.equal(tree.amountFor(entries[3].wallet), entries[3].amount);
  assert.equal(tree.amountFor(stranger), null);
  assert.throws(() => tree.proofFor(stranger), /is not in this epoch/);
});

test("a proof from one epoch does not open another", () => {
  // Two epochs that name the same wallets for the same amounts are unlikely but possible, and the
  // epoch index in every leaf is what stops the first epoch's proofs from draining the second.
  const entries = sample(12);
  const first = buildEpochTree(entries, 0n);
  const second = buildEpochTree(entries, 1n);
  const [mine] = entries;

  assert.ok(!first.root.equals(second.root), "identical entitlements produced identical roots");
  assert.ok(verifyProof(first.root, 0n, mine.wallet, mine.amount, first.proofFor(mine.wallet)));
  assert.ok(
    !verifyProof(second.root, 1n, mine.wallet, mine.amount, first.proofFor(mine.wallet)),
    "an epoch 0 proof was accepted for epoch 1",
  );
  assert.equal(first.index, 0n);
  assert.equal(second.index, 1n);
});
