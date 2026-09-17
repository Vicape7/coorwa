/**
 * What a wallet will put its key on.
 *
 * Every swap Coorwa shows is built somewhere else and signed here: by the user in the terminal and
 * on a claim, by the operator on a payout run. These are the shapes of a build that must never be
 * signed, each one a way for the wallet to come out lighter than the trade it agreed to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { swapRefused, tokenAmount, walletBalance } from "../src/lib/swap-check";
import { COOK_MINT } from "../src/lib/config";

const honest = {
  err: null,
  spent: 1_000n,
  received: 500n,
  maxSpend: 1_000n,
  minReceive: 495n,
  nativeSpent: 2_000_000n,
  nativeAllowed: 2_144_231n,
};

test("a swap that does what the quote said is signed", () => {
  assert.equal(swapRefused(honest), null);
  // Spending less than the trade allows, and returning more than promised, is still fine.
  assert.equal(swapRefused({ ...honest, spent: 900n, received: 600n }), null);
});

test("a swap that reaches beyond what the trade is for is refused", () => {
  assert.match(swapRefused({ ...honest, spent: 1_001n })!, /over the 1000 this trade is for/);
});

test("a swap that gives back less than the quote promised is refused", () => {
  assert.match(swapRefused({ ...honest, received: 494n })!, /under the 495/);
  assert.match(swapRefused({ ...honest, received: 0n })!, /under the 495/);
});

test("a swap that helps itself to the rest of the wallet is refused", () => {
  assert.match(swapRefused({ ...honest, nativeSpent: 2_144_232n })!, /over the 2144231/);
});

test("a swap that does not even simulate is refused before it is signed", () => {
  assert.match(swapRefused({ ...honest, err: { InstructionError: [2, "custom"] } })!, /simulation/);
});

test("native funds are watched on the wallet itself, a token on its own account", () => {
  const owner = new PublicKey("8B8yfsskpq8azPVyZeXNVh4NmQNSgJG9QfH8jDxFmjK7");
  const native = walletBalance({ mint: COOK_MINT, owner, nativeMint: COOK_MINT });
  assert.equal(native.native, true);
  assert.equal(native.address.toBase58(), owner.toBase58());

  const token = walletBalance({
    mint: "BDEFBNgzV5MzCnF4ccWNYbjy5g8wh5Y76T4xkWn1momo",
    owner,
    nativeMint: COOK_MINT,
  });
  assert.equal(token.native, false);
  assert.notEqual(token.address.toBase58(), owner.toBase58());
});

test("an account too short to be a token account holds nothing, rather than throwing", () => {
  assert.equal(tokenAmount(null), 0n);
  assert.equal(tokenAmount(new Uint8Array(40)), 0n);
  const account = new Uint8Array(165);
  new DataView(account.buffer).setBigUint64(64, 12_345n, true);
  assert.equal(tokenAmount(account), 12_345n);
});
