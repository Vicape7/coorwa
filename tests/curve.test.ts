/**
 * The bonding-curve quote.
 *
 * MomoSwap has no quote endpoint, so Corwa prices a curve trade itself before showing a number to
 * anyone. That makes the arithmetic worth pinning against reality rather than against itself: the
 * first two cases replay a buy and the sell that followed it on pool `FvrW6Wkn...` on Cookie Chain,
 * with the reserves the pool actually had at each moment, and assert the raw units the programme
 * settled. If the launchpad ever changes its curve, these fail rather than the app quietly lying.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { quoteBuy, quoteSell, curvePrice, type CurveSnapshot } from "../src/lib/curve";

/** Pool FvrW6WknHYSSLz6HAYjLLZ9GXNYgH9VBJqCcAajXGzg8, as launched: nothing raised, nothing sold. */
const AT_LAUNCH: CurveSnapshot = {
  virtualPaymentReserve: "176471000000000",
  virtualTokenReserve: "1073000000000000",
  paymentRaisedNet: "0",
  tokensSold: "0",
  tradeFeeBps: 100,
};

test("a buy reproduces the fill that settled on chain", () => {
  // 0.03 COOK in, signature 4R4V2Pwr...; the pool went from 0 to 180585448 raw tokens sold.
  const q = quoteBuy(AT_LAUNCH, 30_000_000n);

  assert.equal(q.outRaw, "180585448");
  assert.equal(q.feeRaw, "300000");
  assert.ok(q.impactPct > 0, "buying should push the price up");
});

test("a sell reproduces what the curve paid out", () => {
  // Same pool one trade later, signature rzHn8FJa...: 90 tokens back, 0.014801858 COOK off the curve.
  const afterBuy: CurveSnapshot = {
    ...AT_LAUNCH,
    paymentRaisedNet: "29700000",
    tokensSold: "180585448",
  };

  const q = quoteSell(afterBuy, 90_000_000n);
  const gross = BigInt(q.outRaw) + BigInt(q.feeRaw);

  assert.equal(gross.toString(), "14801858");
  assert.equal(q.outRaw, "14653840");
  assert.ok(q.impactPct < 0, "selling should push the price down");
});

test("the fee is charged on the payment leg, both ways", () => {
  const buy = quoteBuy(AT_LAUNCH, 1_000_000_000n);
  assert.equal(buy.feeRaw, "10000000");

  // A round trip cannot come back whole: two fees and the curve's own spread are paid on the way.
  const afterBuy: CurveSnapshot = {
    ...AT_LAUNCH,
    paymentRaisedNet: (1_000_000_000n - 10_000_000n).toString(),
    tokensSold: buy.outRaw,
  };
  const back = quoteSell(afterBuy, BigInt(buy.outRaw));
  assert.ok(BigInt(back.outRaw) < 1_000_000_000n);
  assert.ok(BigInt(back.outRaw) > 970_000_000n, "a round trip should cost about the two fees");
});

test("an empty or exhausted curve quotes nothing rather than dividing by zero", () => {
  const sold: CurveSnapshot = { ...AT_LAUNCH, tokensSold: AT_LAUNCH.virtualTokenReserve };

  assert.equal(quoteBuy(sold, 1_000_000n).outRaw, "0");
  assert.equal(quoteSell(sold, 1_000_000n).outRaw, "0");
  assert.equal(curvePrice(sold), 0);
  assert.equal(quoteBuy(AT_LAUNCH, 0n).outRaw, "0");
  assert.equal(quoteSell(AT_LAUNCH, 0n).outRaw, "0");
});

test("price rises monotonically as the curve fills", () => {
  const early = curvePrice(AT_LAUNCH);
  const later = curvePrice({
    ...AT_LAUNCH,
    paymentRaisedNet: "50000000000",
    tokensSold: "300000000000",
  });

  assert.ok(later > early, `${later} should be above ${early}`);
});
