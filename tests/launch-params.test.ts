/**
 * The numbers Coorwa's launch program is configured with.
 *
 * These go on chain once and set what every launch after them promises: where the curve starts,
 * what graduates it, what it costs. The program validates them too, but it does so after the
 * transaction is paid for and by then the config is written, so the same rules are checked here
 * where a typo is free to fix. The last case is the one worth the file on its own: the reserves
 * have to sell exactly the curve's supply as the target is reached, not a token more or less.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  CREATOR_LP_SHARE_BPS,
  CURVE_FEE_BPS,
  GRADUATION_QUOTE,
  MIGRATION_BASE,
  SALE_BASE,
  TAX_TIERS,
  TOTAL_SUPPLY,
  VIRTUAL_BASE,
  VIRTUAL_QUOTE,
  launchConfigParams,
} from "../src/lib/launch-params";
import { curvePrice, quoteBuy, type CurveState } from "../src/lib/launch-program";
import { COOK_DECIMALS, CURVE_TOKEN_DECIMALS } from "../src/lib/config";

/** What the program itself refuses, from `ConfigParams::validate`. */
const MAX_CURVE_FEE_BPS = 500;
const BPS = 10_000;

test("the configuration passes every rule the program would check", () => {
  assert.ok(CURVE_FEE_BPS <= MAX_CURVE_FEE_BPS);
  assert.ok(CREATOR_LP_SHARE_BPS <= BPS);
  assert.ok(GRADUATION_QUOTE > 0n);
  assert.ok(SALE_BASE > 0n);
  assert.ok(MIGRATION_BASE > 0n);
  assert.ok(VIRTUAL_QUOTE > 0n);
  // Or the reserve empties mid-raise and the price runs to infinity.
  assert.ok(VIRTUAL_BASE > SALE_BASE);
  assert.ok(CURVE_TOKEN_DECIMALS <= 9);
  assert.ok(TAX_TIERS.some((t) => t > 0));
  assert.ok(TAX_TIERS.every((t) => t < BPS));
});

test("the tiers are the 1, 2 and 3 percent a creator picks between", () => {
  assert.deepEqual(TAX_TIERS, [100, 200, 300, 0]);
});

test("the supply is a billion, split 80/20 between the curve and the pool", () => {
  assert.equal(TOTAL_SUPPLY, 1_000_000_000n * 10n ** BigInt(CURVE_TOKEN_DECIMALS));
  assert.equal(SALE_BASE * 100n / TOTAL_SUPPLY, 80n);
  assert.equal(MIGRATION_BASE * 100n / TOTAL_SUPPLY, 20n);
});

/** A curve at its opening state, priced by the parameters above. */
function fresh(): CurveState {
  const zero = PublicKey.default;
  return {
    address: zero,
    config: zero,
    creator: zero,
    mint: zero,
    baseVault: zero,
    quoteVault: zero,
    virtualBase: VIRTUAL_BASE,
    virtualQuote: VIRTUAL_QUOTE,
    saleBase: SALE_BASE,
    migrationBase: MIGRATION_BASE,
    graduationQuote: GRADUATION_QUOTE,
    baseSold: 0n,
    quoteRaised: 0n,
    feesQuote: 0n,
    taxBps: 100,
    curveFeeBps: CURVE_FEE_BPS,
    creatorLpShareBps: CREATOR_LP_SHARE_BPS,
    state: "live",
    createdAt: 0,
    positionNftMint: zero,
  };
}

test("buying the whole raise sells the whole curve, and graduates it", () => {
  const curve = fresh();
  // What a buyer has to send for the raise to net the target, fee included.
  const gross = (GRADUATION_QUOTE * BigInt(BPS)) / BigInt(BPS - CURVE_FEE_BPS) + 1n;
  const quote = quoteBuy(curve, gross);

  assert.equal(quote.quoteTaken - quote.fee, GRADUATION_QUOTE, "the raise lands on the target");
  assert.equal(quote.graduates, true);
  // Integer division rounds the last token in the curve's favour, so the raise buys all of the
  // sale supply bar a dust unit and can never buy past it, which is what the reserves are for.
  assert.ok(quote.baseOut <= SALE_BASE, "never more than the curve holds");
  assert.ok(SALE_BASE - quote.baseOut <= 1n, `${SALE_BASE - quote.baseOut} units left unsold`);
});

test("a curve opens at 0.0003125 COOK and graduates at 0.005", () => {
  const start = curvePrice(fresh(), CURVE_TOKEN_DECIMALS) / 10 ** COOK_DECIMALS;
  const sold = { ...fresh(), baseSold: SALE_BASE, quoteRaised: GRADUATION_QUOTE };
  const end = curvePrice(sold, CURVE_TOKEN_DECIMALS) / 10 ** COOK_DECIMALS;

  assert.equal(start.toFixed(10), "0.0003125000", "COOK for one token at the first trade");
  assert.equal(end.toFixed(10), "0.0050000000", "and at the last one before it graduates");
  assert.equal(Math.round(end / start), 16);
});

test("fees and the pool split are the ones Coorwa states in public", () => {
  assert.equal(CURVE_FEE_BPS, 100, "1% of a curve trade");
  assert.equal(CREATOR_LP_SHARE_BPS, 4000, "40% of the locked pool's fees to the creator");
});

test("the operator is both where fees land and who sweeps the tax", () => {
  const params = launchConfigParams("3y5zHNgQRSqnjxGSP8TpPoRdixQLEfes7qSqRDejPt8R");
  assert.equal(params.feeRecipient, "3y5zHNgQRSqnjxGSP8TpPoRdixQLEfes7qSqRDejPt8R");
  assert.equal(params.withholdAuthority, params.feeRecipient);
  assert.equal(params.paused, false);
});
