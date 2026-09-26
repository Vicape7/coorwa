/**
 * The tax sweep's arithmetic and bookkeeping, with the chain taken out of it.
 *
 * Every dollar the sweep writes down is paid out to a token's holders, so the one number it takes
 * from a transaction has to be the COOK the operator was actually paid for that token, and nothing
 * else the same transaction happened to log. The rest pins when a token is worth selling at all and
 * how far the sale lets the curve move.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { openingCurve } from "../src/lib/launch-flow";
import {
  EVENT_DISCRIMINATOR,
  quotePoolSwap,
  quoteSell,
  type LaunchConfigState,
} from "../src/lib/launch-program";
import {
  HARVEST_BATCH,
  SWEEP_MIN_COOK,
  harvestBatches,
  poolSalePlan,
  salePlan,
  saleProceeds,
  withheldIn,
} from "../src/lib/tax-sweep";
import {
  CREATOR_LP_SHARE_BPS,
  CURVE_FEE_BPS,
  GRADUATION_QUOTE,
  MIGRATION_BASE,
  SALE_BASE,
  VIRTUAL_BASE,
  VIRTUAL_QUOTE,
} from "../src/lib/launch-params";

const COOK = 10n ** 9n;
const TOKEN = 10n ** 6n;
const creator = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const operator = Keypair.generate().publicKey;

const config: LaunchConfigState = {
  authority: creator,
  feeRecipient: operator,
  withholdAuthority: operator,
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

/** The first live token as it stood on 2026-09-26: 59.80 COOK raised, 191,327 tokens out. */
const traded = {
  ...openingCurve(config, { mint, creator, taxBps: 300 }),
  baseSold: 191_327n * TOKEN,
  quoteRaised: 5_980n * (COOK / 100n),
};

function u64(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** A `Traded` event as the program logs it. */
function tradedLog(e: { mint: PublicKey; trader: PublicKey; isBuy: boolean; quote: bigint }): string {
  const bytes = Uint8Array.from([
    ...EVENT_DISCRIMINATOR.traded,
    ...PublicKey.default.toBytes(),
    ...e.mint.toBytes(),
    ...e.trader.toBytes(),
    e.isBuy ? 1 : 0,
    ...u64(e.quote),
    ...u64(1n),
    ...u64(1n),
    ...u64(1n),
    ...u64(1n),
    0,
  ]);
  return `Program data: ${Buffer.from(bytes).toString("base64")}`;
}

test("only accounts that withhold something are harvested, and their tax is summed", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const c = Keypair.generate().publicKey;
  const out = withheldIn([
    { address: a, withheld: 94_206_731_159n },
    { address: b, withheld: 0n },
    { address: c, withheld: 97_120_341_402n },
  ]);
  assert.deepEqual(out.sources, [a, c]);
  assert.equal(out.total, 191_327_072_561n);
});

test("harvests are split into transactions that fit", () => {
  const sources = Array.from({ length: HARVEST_BATCH * 2 + 3 }, (_, i) => i);
  const batches = harvestBatches(sources);
  assert.deepEqual(
    batches.map((b) => b.length),
    [HARVEST_BATCH, HARVEST_BATCH, 3],
  );
  assert.deepEqual(batches.flat(), sources);
  assert.deepEqual(harvestBatches([]), []);
});

test("a sale is priced exactly as the curve will price it, and may move 2% at most", () => {
  const amount = 191_327_072_561n;
  const plan = salePlan(traded, amount);
  assert.ok(plan);
  assert.equal(plan.expected, quoteSell(traded, amount).quoteOut);
  assert.equal(plan.minOut, (plan.expected * 9_800n) / 10_000n);
  // The first token's tax sells for about 55 COOK: its own tax and the curve's fee come off first.
  assert.ok(plan.expected > 50n * COOK && plan.expected < 60n * COOK);
});

test("too little tax waits for a later pass", () => {
  // At the opening price 10 COOK buys about 32,000 tokens, so a few thousand are not worth a sale.
  assert.equal(salePlan(traded, 5_000n * TOKEN), null);
  assert.equal(salePlan(traded, 0n), null);
  const justEnough = salePlan(traded, 40_000n * TOKEN);
  assert.ok(justEnough && justEnough.expected >= SWEEP_MIN_COOK);
});

test("a curve that is not trading is never sold into", () => {
  assert.equal(salePlan({ ...traded, state: "graduated" }, 191_327n * TOKEN), null);
  assert.equal(salePlan({ ...traded, state: "pooled" }, 191_327n * TOKEN), null);
});

test("the proceeds are the operator's own sale of this token, and nothing else in the logs", () => {
  const other = Keypair.generate().publicKey;
  const logs = [
    "Program log: Instruction: Sell",
    tradedLog({ mint, trader: operator, isBuy: false, quote: 55n * COOK }),
    // Someone else's sale in the same block is not the operator's money.
    tradedLog({ mint, trader: other, isBuy: false, quote: 7n * COOK }),
    // Nor is a buy, or a sale of another token.
    tradedLog({ mint, trader: operator, isBuy: true, quote: 3n * COOK }),
    tradedLog({ mint: other, trader: operator, isBuy: false, quote: 2n * COOK }),
    "Program data: not-an-event",
  ];
  assert.equal(saleProceeds(logs, mint.toBase58(), operator.toBase58()), 55n * COOK);
  assert.equal(saleProceeds(null, mint.toBase58(), operator.toBase58()), 0n);
});

test("after graduation the tax is priced as the pool will price it", () => {
  // A pool holding the first token's close price: sqrt(quote per base) in Q64.64, deep enough.
  const sqrtPrice = 1n << 57n; // price 2^-14 quote per base, raw
  // About 420,000 COOK of quote behind it: reserve = L * sqrtPrice >> 128.
  const pool = { sqrtPrice, liquidity: 10n ** 36n };
  const amount = 191_327_072_561n;
  const plan = poolSalePlan(pool, { amount, baseIsA: true, taxBps: 300 }, 1n);
  assert.ok(plan);
  const quote = quotePoolSwap(pool, { amountIn: amount, inputIsBase: true, baseIsA: true, taxBps: 300 });
  assert.equal(plan.expected, quote.received);
  assert.equal(plan.minOut, (plan.expected * 9_800n) / 10_000n);
  // And the same minimum as on the curve keeps a trickle of tax waiting.
  assert.equal(poolSalePlan(pool, { amount: 1_000n, baseIsA: true, taxBps: 300 }), null);
});

test("a pool sale's proceeds are what the operator's wrapped COOK gained", () => {
  const wsol = "So11111111111111111111111111111111111111112";
  const op = operator.toBase58();
  const balances = {
    pre: [{ mint: wsol, owner: op, uiTokenAmount: { amount: "1000" } }],
    post: [
      { mint: wsol, owner: op, uiTokenAmount: { amount: "58000" } },
      // Somebody else's COOK in the same transaction is not the operator's.
      { mint: wsol, owner: Keypair.generate().publicKey.toBase58(), uiTokenAmount: { amount: "9" } },
    ],
  };
  assert.equal(saleProceeds([], mint.toBase58(), op, balances), 57_000n);
  // A curve sale still reads its own event, whatever the balances say.
  const logs = [tradedLog({ mint, trader: operator, isBuy: false, quote: 55n * COOK })];
  assert.equal(saleProceeds(logs, mint.toBase58(), op, balances), 55n * COOK);
});
