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
import {
  authorityChanged,
  swapRefused,
  tokenAmount,
  tokenAuthorities,
  walletBalance,
} from "../src/lib/swap-check";
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

// --- Who controls the account -------------------------------------------------------------------

const wallet = new PublicKey("8B8yfsskpq8azPVyZeXNVh4NmQNSgJG9QfH8jDxFmjK7");
const stranger = new PublicKey("3y5zHNgQRSqnjxGSP8TpPoRdixQLEfes7qSqRDejPt8R");

/** A token account in the layout SPL and Token-2022 share, with a Token-2022 extension tail. */
function account(opts: {
  owner?: PublicKey;
  amount?: bigint;
  delegate?: PublicKey;
  delegatedAmount?: bigint;
  closeAuthority?: PublicKey;
}): Uint8Array {
  const data = new Uint8Array(182);
  const view = new DataView(data.buffer);
  data.set((opts.owner ?? wallet).toBytes(), 32);
  view.setBigUint64(64, opts.amount ?? 1_000n, true);
  if (opts.delegate) {
    view.setUint32(72, 1, true);
    data.set(opts.delegate.toBytes(), 76);
  }
  data[108] = 1; // initialized
  view.setBigUint64(121, opts.delegatedAmount ?? 0n, true);
  if (opts.closeAuthority) {
    view.setUint32(129, 1, true);
    data.set(opts.closeAuthority.toBytes(), 133);
  }
  return data;
}

test("a token account's authorities are read from the shared layout", () => {
  const read = tokenAuthorities(
    account({ delegate: stranger, delegatedAmount: 7n, closeAuthority: stranger }),
  );
  assert.deepEqual(read, {
    owner: wallet.toBase58(),
    delegate: stranger.toBase58(),
    delegatedAmount: 7n,
    closeAuthority: stranger.toBase58(),
  });
  assert.equal(tokenAuthorities(null), null);
  assert.equal(tokenAuthorities(new Uint8Array(100)), null);
});

test("a swap that only moves the balance leaves control where it was", () => {
  assert.equal(authorityChanged(account({}), account({ amount: 0n }), wallet), null);
  // A delegate the wallet set up before this swap is not the swap's doing.
  const kept = { delegate: stranger, delegatedAmount: 50n };
  assert.equal(authorityChanged(account(kept), account(kept), wallet), null);
});

test("a swap that creates the output account creates it plain", () => {
  assert.equal(authorityChanged(null, account({}), wallet), null);
  assert.match(
    authorityChanged(null, account({ delegate: stranger, delegatedAmount: 1n }), wallet)!,
    /lets .* spend 1 units/,
  );
});

test("a swap that approves somebody to spend the account later is refused", () => {
  assert.match(
    authorityChanged(account({}), account({ delegate: stranger, delegatedAmount: 2n ** 64n - 1n }), wallet)!,
    new RegExp(`lets ${stranger.toBase58()} spend`),
  );
  // Raising an allowance the wallet already gave is the same thing.
  assert.match(
    authorityChanged(
      account({ delegate: stranger, delegatedAmount: 5n }),
      account({ delegate: stranger, delegatedAmount: 500n }),
      wallet,
    )!,
    /spend 500 units/,
  );
});

test("a swap that hands the account or its closing to somebody else is refused", () => {
  assert.match(
    authorityChanged(account({}), account({ owner: stranger }), wallet)!,
    /hands the token account to/,
  );
  assert.match(
    authorityChanged(account({}), account({ closeAuthority: stranger }), wallet)!,
    /right to close/,
  );
});

test("an account the swap closed has nothing left to take", () => {
  assert.equal(authorityChanged(account({}), null, wallet), null);
  assert.equal(authorityChanged(account({}), new Uint8Array(0), wallet), null);
});
