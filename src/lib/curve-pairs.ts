/**
 * Pairs whose token is still on its MomoSwap bonding curve.
 *
 * A token launched through Coorwa has its pair from the first block, but it has no pool until the
 * curve graduates, so Cookiescan knows no price for it and `buildUniverse` leaves it out. This file
 * prices it from the curve instead: the curve's reserves give the token in COOK, COOK's own market
 * gives that in USD, and the stock's price divides it, the same ratio `pairs.ts` draws for a pool.
 *
 * A curve pair is addressed by its mint (`<mint>-<ticker>`), never by its symbol. A symbol is free
 * text, and a new launch calling itself after an existing pair would otherwise take over its link.
 */
import { COOK_DECIMALS, COOK_SOLANA_MINT, CURVE_TOKEN_DECIMALS } from "./config";
import { fetchCookPriceUsd } from "./cookiescan";
import { curvePrice } from "./curve";
import { closeAt, fetchRwaCandles, type Candle, type Trade } from "./candles";
import { fetchRwaPrices } from "./jupiter";
import {
  fetchPools,
  fetchPoolTrades,
  graduationProgress,
  type LaunchpadPool,
} from "./launchpad";
import { benchmarks } from "./launches";
import { listedByMint } from "./listings";
import { rwaByTicker } from "./rwa";
import { logosByMint } from "./token-logos";

export interface CurvePair {
  slug: string;
  base: { mint: string; symbol: string; name: string; logo: string | null };
  quote: {
    ticker: string;
    symbol: string;
    mint: string;
    name: string;
    priceUsd: number;
    change24h: number | null;
  };
  pool: LaunchpadPool & { progress: number };
  cookPriceUsd: number | null;
  /** The token's spot price on the curve, in USD. Null until COOK has a price. */
  priceUsd: number | null;
  /** How many stock shares one token is worth. */
  price: number | null;
  /** How many tokens buy one whole share. */
  inverse: number | null;
  raisedUsd: number | null;
}

export function curveSlug(mint: string, ticker: string): string {
  return `${mint}-${ticker.toLowerCase()}`;
}

/** COOK per whole token at the curve's current reserves. */
export function curvePriceCook(pool: LaunchpadPool): number {
  return curvePrice(pool) * 10 ** (CURVE_TOKEN_DECIMALS - COOK_DECIMALS);
}

/** Resolve `<mint>-<ticker>` to a curve pair, when that mint was launched or listed in that asset. */
export async function findCurvePair(slug: string): Promise<CurvePair | null> {
  const idx = slug.lastIndexOf("-");
  if (idx < 1) return null;
  const asset = rwaByTicker(slug.slice(idx + 1));
  if (!asset) return null;
  const mint = slug.slice(0, idx);

  const [pools, pinned, listed] = await Promise.all([
    fetchPools("all"),
    benchmarks(),
    listedByMint(),
  ]);
  const pool = pools.find((p) => p.tokenMint === mint);
  if (!pool) return null;
  if ((pinned.get(mint) ?? listed.get(mint)) !== asset.ticker) return null;

  const [cookPriceUsd, prices, logos] = await Promise.all([
    fetchCookPriceUsd(),
    fetchRwaPrices(),
    logosByMint([{ mint, uri: pool.uri }]),
  ]);
  const stock = prices[asset.ticker];
  if (!stock || !(stock.priceUsd > 0)) return null;

  const logo = logos.get(mint) ?? null;
  const priceCook = curvePriceCook(pool);
  const priceUsd = cookPriceUsd && priceCook > 0 ? priceCook * cookPriceUsd : null;
  const raisedCook = Number(pool.paymentRaisedNet) / 10 ** COOK_DECIMALS;

  return {
    slug: curveSlug(mint, asset.ticker),
    base: {
      mint,
      symbol: pool.symbol.trim() || mint.slice(0, 4),
      name: pool.name.trim() || pool.symbol,
      logo,
    },
    quote: {
      ticker: asset.ticker,
      symbol: asset.symbol,
      mint: asset.mint,
      name: asset.name,
      priceUsd: stock.priceUsd,
      change24h: stock.change24h,
    },
    pool: { ...pool, logo, progress: graduationProgress(pool) },
    cookPriceUsd,
    priceUsd,
    price: priceUsd ? priceUsd / stock.priceUsd : null,
    inverse: priceUsd ? stock.priceUsd / priceUsd : null,
    raisedUsd: cookPriceUsd ? raisedCook * cookPriceUsd : null,
  };
}

/**
 * A curve's fills in the shape the pool feed uses, newest first. Each fill is valued in USD at COOK's
 * price in the hour it traded, so the chart and the list show what it was worth then.
 */
export async function curveFills(pool: string, mint: string): Promise<Trade[]> {
  const [trades, cook, cookNow] = await Promise.all([
    fetchPoolTrades(pool),
    fetchRwaCandles(COOK_SOLANA_MINT, "1h", 1000).catch(() => [] as Candle[]),
    fetchCookPriceUsd(),
  ]);
  const series = [...cook].filter((c) => c.close > 0).sort((a, b) => a.time - b.time);

  return trades
    .map((t, i) => {
      const cookUsd = closeAt(series, t.ts, cookNow) ?? 0;
      return {
        id: i,
        mint,
        ts: t.ts,
        price: t.price,
        price_usd: t.price * cookUsd,
        base_amount: t.tokens,
        quote_amount: t.payment,
        side: t.side,
        tx: t.sig,
        maker: t.trader,
        pool,
        venue: "MomoSwap curve",
        value_usd: t.payment * cookUsd,
      };
    })
    .sort((a, b) => b.ts - a.ts);
}
