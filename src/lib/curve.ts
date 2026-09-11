/**
 * Bonding-curve pricing, on its own so the browser can use it.
 *
 * MomoSwap publishes no quote endpoint, so Coorwa reconstructs the curve from numbers the pool feed
 * already carries and prices the trade itself. It is a constant product over virtual reserves: the
 * two `virtual*` fields are constants set when the pool was created, and what has since been raised
 * and sold moves them. Replayed against a fill that actually settled on chain this reproduces both
 * legs to the raw unit, which `tests/curve.test.ts` pins.
 *
 * Every number here is still shown as an estimate, because the reserves move the moment anyone else
 * trades - the programme decides the fill, not this. Nothing in this file touches the network or
 * the environment, which is what keeps it importable from a client component.
 */

/** Enough of a pool to price a trade against it. */
export interface CurveSnapshot {
  virtualPaymentReserve: string;
  virtualTokenReserve: string;
  paymentRaisedNet: string;
  tokensSold: string;
  tradeFeeBps: number;
}

export interface CurveQuote {
  /** What the trader receives: raw token units on a buy, raw payment units on a sell. */
  outRaw: string;
  /** The launchpad's cut, always in raw payment units. It is charged on the payment leg both ways. */
  feeRaw: string;
  /** How far this trade moves the marginal price, in percent. */
  impactPct: number;
}

const NO_QUOTE: CurveQuote = { outRaw: "0", feeRaw: "0", impactPct: 0 };

function reserves(c: CurveSnapshot): { payment: bigint; token: bigint } {
  return {
    payment: BigInt(c.virtualPaymentReserve) + BigInt(c.paymentRaisedNet),
    token: BigInt(c.virtualTokenReserve) - BigInt(c.tokensSold),
  };
}

/** Marginal price on the curve as it stands, in raw payment units per raw token unit. */
export function curvePrice(c: CurveSnapshot): number {
  const { payment, token } = reserves(c);
  return token > 0n ? Number(payment) / Number(token) : 0;
}

function impact(
  before: { payment: bigint; token: bigint },
  payment: bigint,
  token: bigint,
): number {
  const p0 = Number(before.payment) / Number(before.token);
  if (!(p0 > 0) || token <= 0n) return 0;
  return (Number(payment) / Number(token) / p0 - 1) * 100;
}

/** The fee comes off the payment first, and only the remainder buys along the curve. */
export function quoteBuy(c: CurveSnapshot, paymentRaw: bigint): CurveQuote {
  const fee = (paymentRaw * BigInt(c.tradeFeeBps)) / 10_000n;
  const net = paymentRaw - fee;
  const r = reserves(c);
  if (net <= 0n || r.payment <= 0n || r.token <= 0n) return NO_QUOTE;

  const out = (r.token * net) / (r.payment + net);
  return {
    outRaw: out.toString(),
    feeRaw: fee.toString(),
    impactPct: impact(r, r.payment + net, r.token - out),
  };
}

/** Selling runs the curve the other way, and the fee comes off what the curve pays out. */
export function quoteSell(c: CurveSnapshot, sharesRaw: bigint): CurveQuote {
  const r = reserves(c);
  if (sharesRaw <= 0n || r.payment <= 0n || r.token <= 0n) return NO_QUOTE;

  const gross = (r.payment * sharesRaw) / (r.token + sharesRaw);
  const fee = (gross * BigInt(c.tradeFeeBps)) / 10_000n;
  return {
    outRaw: (gross - fee).toString(),
    feeRaw: fee.toString(),
    impactPct: impact(r, r.payment - gross, r.token + sharesRaw),
  };
}
