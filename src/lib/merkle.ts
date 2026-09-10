/**
 * The merkle tree behind a cashback epoch.
 *
 * This is the off-chain half of `programs/corwa-vault`. Corwa works out who is owed what, commits
 * the whole list to a single root, and publishes only that root on chain. A claimant then proves
 * their own line of the list, and the program pays it. Nothing here is trusted: if this file built
 * a tree that disagreed with the amounts Corwa showed, the proof would simply fail on chain.
 *
 * Three rules have to match `leaf_hash` and `root_from_proof` in the program exactly, byte for
 * byte, or every proof this file produces is worthless:
 *
 *   1. A leaf is `sha256(0x00 || epoch index || claimant || amount)`, the two numbers as u64
 *      little-endian. The epoch index is in there so a proof opens one epoch and no other.
 *   2. An internal node is `sha256(0x01 || lower || higher)`, the pair sorted by byte order. That
 *      is what lets a proof be a plain list of siblings with no direction bits.
 *   3. Prefixes 0x00 and 0x01 keep the two apart, so no internal node can be replayed as a leaf.
 *
 * Server side only, because it hashes with node:crypto. The browser never needs it: it receives a
 * finished proof from the API and hands it straight to the program.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/** Matches MAX_PROOF_LEN in the program, which is what makes a tree this deep still claimable. */
export const MAX_PROOF_LEN = 24;

export interface Entitlement {
  /** Base58 wallet that may claim. */
  wallet: string;
  /** Raw token units, not a display amount. */
  amount: bigint;
}

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function amountLe(amount: bigint): Buffer {
  if (amount < 0n) throw new Error("a cashback amount cannot be negative");
  if (amount > 0xffffffffffffffffn) throw new Error("a cashback amount does not fit in u64");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(amount);
  return b;
}

export function leafHash(epochIndex: bigint, wallet: string, amount: bigint): Buffer {
  return sha256(
    LEAF_PREFIX,
    amountLe(epochIndex),
    Buffer.from(new PublicKey(wallet).toBytes()),
    amountLe(amount),
  );
}

function nodeHash(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0
    ? sha256(NODE_PREFIX, a, b)
    : sha256(NODE_PREFIX, b, a);
}

export interface EpochTree {
  /** The epoch this tree was built for. Baked into every leaf, so it cannot be swapped later. */
  index: bigint;
  root: Buffer;
  /** Entitlements in the order the tree used, which is by leaf hash rather than by input order. */
  entries: Entitlement[];
  total: bigint;
  /** Sibling hashes from the leaf upwards. Empty for a one-claimant epoch, which is legal. */
  proofFor(wallet: string): Buffer[];
  amountFor(wallet: string): bigint | null;
  depth: number;
}

/**
 * Build the tree for one epoch.
 *
 * Leaves are sorted by their own hash, so the same set of entitlements always produces the same
 * root no matter what order the database returned them in. That matters more than it sounds:
 * republishing the same epoch after a crash has to land on the same root, otherwise proofs handed
 * out before the crash stop working.
 *
 * An odd node at any level is carried up unchanged rather than paired with a copy of itself.
 * Duplicating it would let one leaf stand in for its own sibling, and the verifier walks a proof
 * one sibling at a time, so a carried node simply contributes no step.
 */
export function buildEpochTree(entitlements: Entitlement[], epochIndex: bigint): EpochTree {
  if (entitlements.length === 0) throw new Error("an epoch needs at least one claimant");
  if (epochIndex < 0n) throw new Error("an epoch index cannot be negative");

  const seen = new Set<string>();
  for (const e of entitlements) {
    if (e.amount <= 0n) throw new Error(`entitlement for ${e.wallet} is not a positive amount`);
    if (seen.has(e.wallet)) {
      // Two leaves for one wallet would each be claimable, so the epoch would pay them twice.
      throw new Error(`${e.wallet} appears twice in this epoch`);
    }
    seen.add(e.wallet);
  }

  const decorated = entitlements
    .map((e) => ({ entry: e, hash: leafHash(epochIndex, e.wallet, e.amount) }))
    .sort((a, b) => Buffer.compare(a.hash, b.hash));

  const entries = decorated.map((d) => d.entry);
  const index = new Map(entries.map((e, i) => [e.wallet, i]));

  const layers: Buffer[][] = [decorated.map((d) => d.hash)];
  while (layers[layers.length - 1].length > 1) {
    const below = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < below.length; i += 2) {
      next.push(i + 1 < below.length ? nodeHash(below[i], below[i + 1]) : below[i]);
    }
    layers.push(next);
  }

  const depth = layers.length - 1;
  if (depth > MAX_PROOF_LEN) {
    throw new Error(`this epoch is ${depth} levels deep and the program will only walk ${MAX_PROOF_LEN}`);
  }

  const total = entries.reduce((sum, e) => sum + e.amount, 0n);

  return {
    index: epochIndex,
    root: layers[layers.length - 1][0],
    entries,
    total,
    depth,
    amountFor(wallet) {
      const i = index.get(wallet);
      return i === undefined ? null : entries[i].amount;
    },
    proofFor(wallet) {
      const i = index.get(wallet);
      if (i === undefined) throw new Error(`${wallet} is not in this epoch`);

      const proof: Buffer[] = [];
      let position = i;
      for (let level = 0; level < layers.length - 1; level += 1) {
        const sibling = position ^ 1;
        // No sibling means this node was carried up, so the walk skips a step here.
        if (sibling < layers[level].length) proof.push(layers[level][sibling]);
        position = Math.floor(position / 2);
      }
      return proof;
    },
  };
}

/**
 * The same walk the program does, for checking a proof before it is handed out. A proof that fails
 * here would have failed on chain, and finding that out costs nothing on this side.
 */
export function rootFromProof(leaf: Buffer, proof: Buffer[]): Buffer {
  let node = leaf;
  for (const sibling of proof) node = nodeHash(node, sibling);
  return node;
}

export function verifyProof(
  root: Buffer,
  epochIndex: bigint,
  wallet: string,
  amount: bigint,
  proof: Buffer[],
): boolean {
  return rootFromProof(leafHash(epochIndex, wallet, amount), proof).equals(root);
}
