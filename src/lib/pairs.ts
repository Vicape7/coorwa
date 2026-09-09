/**
 * The pair engine - Corwa's core idea.
 *
 * A Corwa pair is TOKEN/RWA: a Cookie Chain token quoted in shares of a real-world asset. There is
 * no TOKEN/NVDA pool anywhere, and Corwa never pretends there is. The pair is a *denomination*
 * built from two independently verifiable prices:
 *
 *     price(TOKEN in NVDA) = usd(TOKEN) / usd(NVDAx)
 *
 * where usd(TOKEN) comes from real Cookie Chain pool reserves (via Cookiescan) and usd(NVDAx) comes
 * from real Solana liquidity (via Jupiter). Both sides are live market prices, so the ratio is
 * exact - it is a change of units, not a synthetic instrument.
 *
 * What that buys the trader is the number that actually matters and that no COOK-denominated
 * terminal can show: whether a token is beating NVIDIA. Settlement stays honest too - liquidity is
 * the real TOKEN/wCOOK pool, and anyone wanting true RWA exposure exits through the cross-chain
 * route in `crosschain.ts`.
 */
import { COOK_MINT } from "./config";
import {
  fetchTokens,
  fetchMarkets,
  fetchCookPriceUsd,
  liquidityByMint,
  marketsByMint,
  type CookiescanToken,
  type CookiescanMarket,
} from "./cookiescan";
import { fetchRwaPrices, type RwaQuote } from "./jupiter";
import { RWA_ASSETS, rwaByTicker, DEFAULT_RWA } from "./rwa";

export interface CorwaPair {
  /** URL slug, e.g. "cookhouse-nvda". */
  slug: string;
  base: {
    mint: string;
    symbol: string;
    name: string;
    logo: string | null;
    decimals: number;
    priceUsd: number;
    priceCook: number | null;
    change24h: number | null;
    liquidityUsd: number;
    volume24h: number | null;
    marketCap: number | null;
    holders: number | null;
    /**
     * True when the base token has not traded in 24h. Its price is a standing pool quote, not a
     * market, so `change24h` below is arithmetic rather than information.
     */
    stale: boolean;
  };
  quote: {
    ticker: string;
    symbol: string;
    mint: string;
    name: string;
    logo: string;
    priceUsd: number;
    change24h: number | null;
  };
  /** How many RWA shares one base token is worth. Always tiny - render with `rwaRatio`. */
  price: number;
  /** How many base tokens buy one whole RWA share. The human-readable direction. */
  inverse: number;
  /**
   * 24h move of the ratio itself: the base token's return measured against the RWA's return.
   * Positive means the token outperformed the stock over the window.
   *
   * Null when the base token did not trade. A flat token against a stock that moved would
   * otherwise read as a real outperformance, which would be the terminal lying by omission.
   */
  change24h: number | null;
  /** Deepest real pool backing the base token, and the venue it lives on. */
  venue: string | null;
  poolId: string | null;
}

export interface PairUniverse {
  pairs: CorwaPair[];
  cookPriceUsd: number | null;
  rwa: RwaQuote[];
  /** Cookie Chain mints that have real liquidity but no usable price yet. */
  skipped: number;
  updatedAt: string;
}

function slugify(symbol: string, ticker: string): string {
  const s = symbol.toLowerCase().replace(/[^a-z0-9]+/g, "") || "token";
  return `${s}-${ticker.toLowerCase()}`;
}

/** Ratio return: how the pair moved once the RWA's own move is divided out. */
function ratioChange(tokenPct: number | null, rwaPct: number | null): number | null {
  if (tokenPct == null || !Number.isFinite(tokenPct)) return null;
  const r = rwaPct ?? 0;
  const denom = 1 + r / 100;
  if (denom <= 0) return null;
  return ((1 + tokenPct / 100) / denom - 1) * 100;
}

function tokenUsd(t: CookiescanToken, cookUsd: number | null): number | null {
  const direct = t.price?.usd;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
  const native = t.price?.native;
  if (cookUsd && typeof native === "number" && Number.isFinite(native) && native > 0) {
    return native * cookUsd;
  }
  return null;
}

/**
 * Build the tradeable universe: every Cookie Chain token with real pool depth, crossed with every
 * RWA in the registry.
 */
export async function buildUniverse(opts?: { quotes?: string[]; minLiquidityUsd?: number }): Promise<PairUniverse> {
  const [tokens, markets, cookUsd, rwaPrices] = await Promise.all([
    fetchTokens(),
    fetchMarkets(),
    fetchCookPriceUsd(),
    fetchRwaPrices(),
  ]);

  const minLiq = opts?.minLiquidityUsd ?? 1;
  const liqMap = liquidityByMint(markets);
  const mktMap = marketsByMint(markets);
  const tokenByMint = new Map(tokens.map((t) => [t.mint, t]));

  const quoteTickers = opts?.quotes?.length
    ? opts.quotes.map((q) => rwaByTicker(q)).filter((a): a is NonNullable<typeof a> => !!a)
    : RWA_ASSETS;

  const pairs: CorwaPair[] = [];
  let skipped = 0;

  // Only mints that actually appear in a pool are tradeable, so the markets feed defines the set.
  for (const [mint, liquidityUsd] of liqMap) {
    if (liquidityUsd < minLiq) continue;
    const t = tokenByMint.get(mint);
    if (!t) {
      skipped++;
      continue;
    }
    const usd = tokenUsd(t, cookUsd);
    if (usd == null || usd <= 0) {
      skipped++;
      continue;
    }

    // No 24h volume means the quoted price is the pool's standing price, not a traded one.
    const vol = t.marketData?.volume24h ?? 0;
    const stale = !(vol > 0);

    const pools = mktMap.get(mint) ?? [];
    const deepest = pools[0] as CookiescanMarket | undefined;
    const symbol = t.metadata?.symbol?.trim() || mint.slice(0, 4);

    for (const asset of quoteTickers) {
      const rwa = rwaPrices[asset.ticker];
      if (!rwa || !(rwa.priceUsd > 0)) continue;

      pairs.push({
        slug: slugify(symbol, asset.ticker),
        base: {
          mint,
          symbol,
          name: t.metadata?.name?.trim() || symbol,
          logo: t.metadata?.logo ?? null,
          decimals: t.metadata?.decimals ?? 6,
          priceUsd: usd,
          priceCook: t.price?.native ?? null,
          change24h: t.price?.change24h ?? null,
          liquidityUsd,
          volume24h: t.marketData?.volume24h ?? null,
          marketCap: t.marketData?.marketCap ?? null,
          holders: t.marketData?.holderCount ?? null,
          stale,
        },
        quote: {
          ticker: asset.ticker,
          symbol: asset.symbol,
          mint: asset.mint,
          name: asset.name,
          logo: asset.logo,
          priceUsd: rwa.priceUsd,
          change24h: rwa.change24h,
        },
        price: usd / rwa.priceUsd,
        inverse: rwa.priceUsd / usd,
        change24h: stale ? null : ratioChange(t.price?.change24h ?? null, rwa.change24h),
        venue: deepest?.type ?? null,
        poolId: deepest?.marketId ?? null,
      });
    }
  }

  pairs.sort((a, b) => b.base.liquidityUsd - a.base.liquidityUsd);

  return {
    pairs,
    cookPriceUsd: cookUsd,
    rwa: Object.values(rwaPrices).sort(
      (a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0),
    ),
    skipped,
    updatedAt: new Date().toISOString(),
  };
}

/** Resolve a slug like "cookhouse-nvda", or "<mint>-nvda", to a single pair. */
export async function findPair(slug: string): Promise<CorwaPair | null> {
  const idx = slug.lastIndexOf("-");
  if (idx < 1) return null;
  const ticker = slug.slice(idx + 1);
  const asset = rwaByTicker(ticker);
  if (!asset) return null;

  const universe = await buildUniverse({ quotes: [asset.ticker] });
  const want = slug.slice(0, idx).toLowerCase();
  return (
    universe.pairs.find((p) => p.slug === slug.toLowerCase()) ??
    universe.pairs.find((p) => p.base.mint.toLowerCase() === want) ??
    null
  );
}

export { DEFAULT_RWA, COOK_MINT };
