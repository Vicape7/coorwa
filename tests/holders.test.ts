/**
 * Who counts as a holder at a snapshot.
 *
 * The chain read itself is plain; the part that decides where money goes is this filter. Paying a
 * pool vault or a program address sends a reward nobody can ever claim, and paying dust accounts
 * spreads a pool over wallets that will never clear the claim minimum.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { eligibleHolders, isWallet } from "../src/lib/holders";

const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();
const base = {
  decimals: 6,
  priceUsd: null,
  minUsd: 1,
  excluded: new Set<string>(),
  isWallet: () => true,
};

test("a wallet's accounts are summed into one weight", () => {
  const held = eligibleHolders({
    ...base,
    accounts: [
      { owner: alice, amountRaw: 2n },
      { owner: alice, amountRaw: 3n },
      { owner: bob, amountRaw: 0n },
    ],
  });
  assert.deepEqual([...held], [[alice, 5n]]);
});

test("program addresses and excluded wallets never share a pool", () => {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], Keypair.generate().publicKey);
  assert.equal(isWallet(pda.toBase58()), false, "a PDA is off the curve");
  assert.equal(isWallet(alice), true);

  const held = eligibleHolders({
    ...base,
    isWallet,
    excluded: new Set([bob]),
    accounts: [
      { owner: pda.toBase58(), amountRaw: 1_000n },
      { owner: bob, amountRaw: 1_000n },
      { owner: alice, amountRaw: 1_000n },
    ],
  });
  assert.deepEqual([...held.keys()], [alice]);
});

test("the USD floor applies when the token has a price, and only then", () => {
  const accounts = [
    { owner: alice, amountRaw: 2_000_000n }, // 2 tokens
    { owner: bob, amountRaw: 500_000n }, // 0.5 tokens
  ];
  const priced = eligibleHolders({ ...base, priceUsd: 1, accounts });
  assert.deepEqual([...priced.keys()], [alice], "0.5 tokens at $1 is under a $1 floor");

  const unpriced = eligibleHolders({ ...base, priceUsd: null, accounts });
  assert.equal(unpriced.size, 2, "with no price every positive balance counts");
});
