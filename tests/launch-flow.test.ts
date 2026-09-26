/**
 * Building a launch in the browser.
 *
 * The launchpad used to refuse a launch that carried a buy, because the two did not fit one
 * transaction, and the only sign of it was a rejected build. Coorwa's own launch has to answer that
 * question before anything is signed, so the size is measured here, on the longest name, symbol and
 * uri a launch can have. The rest pins what a dev buy is made of: wrapping COOK, buying, and
 * unwrapping the change only out of an account this flow opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { openingCurve, planLaunch, quoteDevBuy, transactionSize } from "../src/lib/launch-flow";
import { LAUNCH_PROGRAM_ID, type LaunchConfigState } from "../src/lib/launch-program";
import {
  CREATOR_LP_SHARE_BPS,
  CURVE_FEE_BPS,
  GRADUATION_QUOTE,
  MIGRATION_BASE,
  SALE_BASE,
  VIRTUAL_BASE,
  VIRTUAL_QUOTE,
} from "../src/lib/launch-params";

const BLOCKHASH = "11111111111111111111111111111111";
const creator = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

const config: LaunchConfigState = {
  authority: creator,
  feeRecipient: creator,
  withholdAuthority: creator,
  quoteMint: NATIVE_MINT,
  curveFeeBps: CURVE_FEE_BPS,
  creatorLpShareBps: CREATOR_LP_SHARE_BPS,
  taxTiers: [100, 200, 300, 0],
  graduationQuote: GRADUATION_QUOTE,
  saleBase: SALE_BASE,
  migrationBase: MIGRATION_BASE,
  virtualQuote: VIRTUAL_QUOTE,
  virtualBase: VIRTUAL_BASE,
  tokenDecimals: 6,
  paused: false,
  dammConfig: NATIVE_MINT,
  bump: 255,
  launchCount: 0n,
};

/** The longest a launch can be: 32 characters of name, 10 of symbol, a full-length uri. */
const LONGEST = {
  name: "N".repeat(32),
  symbol: "S".repeat(10),
  uri: `https://coorwa.fun/t/${"1".repeat(44)}`,
};

function input(overrides: Partial<Parameters<typeof planLaunch>[0]> = {}) {
  return {
    creator,
    mint,
    ...LONGEST,
    taxBps: 300,
    devBuyQuote: 0n,
    minBaseOut: 0n,
    closeWrapped: true,
    ...overrides,
  };
}

test("a launch on its own is one transaction against the launch program", () => {
  const plan = planLaunch(input(), BLOCKHASH);
  assert.equal(plan.transactions.length, 1);
  assert.equal(plan.split, false);

  const [tx] = plan.transactions;
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.instructions[0].programId.toBase58(), LAUNCH_PROGRAM_ID.toBase58());
  // The mint signs the transaction that brings it into existence, and never again.
  assert.ok(tx.instructions[0].keys.some((k) => k.pubkey.equals(mint) && k.isSigner));
});

test("a launch with a dev buy still fits one transaction, at the longest metadata allowed", () => {
  const plan = planLaunch(input({ devBuyQuote: 5_000_000_000n, minBaseOut: 1n }), BLOCKHASH);
  assert.equal(plan.split, false, "the buy had to be moved out, which costs the creator a step");
  assert.equal(plan.transactions.length, 1);
  assert.ok(
    transactionSize(plan.transactions[0], 2) <= 1232,
    `${transactionSize(plan.transactions[0], 2)} bytes`,
  );
});

test("a dev buy wraps COOK, buys, and unwraps the change", () => {
  const plan = planLaunch(input({ devBuyQuote: 5_000_000_000n, minBaseOut: 1n }), BLOCKHASH);
  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, creator);
  const base = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);
  const [tx] = plan.transactions;

  // launch, open the wrapped account, fund it, sync it, open the token account, buy, close.
  assert.equal(tx.instructions.length, 7);
  assert.ok(tx.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(wrapped))));
  assert.ok(tx.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(base))));
  // The buy is the one that names both sides and the program.
  const buy = tx.instructions.find(
    (ix, i) => i > 0 && ix.programId.equals(LAUNCH_PROGRAM_ID),
  );
  assert.ok(buy, "there is a buy after the launch");
});

test("a creator who already holds wrapped COOK keeps it wrapped", () => {
  const plan = planLaunch(
    input({ devBuyQuote: 5_000_000_000n, minBaseOut: 1n, closeWrapped: false }),
    BLOCKHASH,
  );
  assert.equal(plan.transactions[0].instructions.length, 6, "no close at the end");
});

test("the opening curve prices a dev buy the way the program will", () => {
  const curve = openingCurve(config, { mint, creator, taxBps: 300 });
  assert.equal(curve.quoteRaised, 0n);
  assert.equal(curve.baseSold, 0n);
  assert.equal(curve.taxBps, 300);

  const quote = quoteDevBuy(config, { mint, creator, taxBps: 300 }, 1_000_000_000n);
  // 1% of the buy is Coorwa's, and 3% of what the curve sends is withheld as tax.
  assert.equal(quote.fee, 10_000_000n);
  assert.ok(quote.baseOut > 0n);
  assert.equal(quote.baseReceived, quote.baseOut - (quote.baseOut * 300n + 9_999n) / 10_000n);
  assert.equal(quote.graduates, false);
});

test("a dev buy big enough to graduate says so before it is signed", () => {
  const quote = quoteDevBuy(
    config,
    { mint, creator, taxBps: 100 },
    (GRADUATION_QUOTE * 10_000n) / 9_900n + 1n,
  );
  assert.equal(quote.graduates, true);
});

test("the mint is never the fee payer", () => {
  const [tx] = planLaunch(input(), BLOCKHASH).transactions;
  assert.equal(tx.feePayer?.toBase58(), creator.toBase58());
  assert.notEqual(tx.feePayer?.toBase58(), PublicKey.default.toBase58());
});
