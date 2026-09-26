/**
 * The pair engine - Coorwa's core idea.
 *
 * A Coorwa pair is TOKEN/RWA: a Cookie Chain token quoted in shares of a real-world asset. There is
 * no TOKEN/NVDA pool anywhere, and Coorwa never pretends there is. The pair is a *denomination*
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
 *
 * A token has exactly one pair, chosen by its creator: at launch for a token launched through Coorwa
 * (`launches.ts`), or once, for a dollar, for any other token (`listings.ts`). The pair's asset is
 * what the token's holders are paid in. A token without one is not in the terminal. With no database
 * there are no pairs at all.
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
import { benchmarks } from "./launches";
import { listedByMint } from "./listings";
import { fetchPools } from "./launchpad";
import { logosByMint } from "./token-logos";
import { cachedStale } from "./http";
import { coorwaPairs, type CoorwaPair as CoorwaCurvePair } from "./coorwa-pairs";

export interface CoorwaPair {
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
  /** True when this token was launched through Coorwa and its creator picked this asset at launch. */
  pinned: boolean;
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
  pairs: CoorwaPair[];
  cookPriceUsd: number | null;
  rwa: RwaQuote[];
  /** Cookie Chain mints that have real liquidity but no usable price yet. */
  skipped: number;
  updatedAt: string;
}

/**
 * Which asset a token is quoted against: the benchmark its creator picked at launch, or else the one
 * its creator bought. At most one, and nothing for a token with neither.
 *
 * The narrowing matters: asking for one asset a token does not carry has to come back empty rather
 * than falling back to the full set, or `findPair("token-nvda")` would happily resolve a pair
 * nobody chose and nobody paid for.
 */
export function quotesFor<T extends { ticker: string }>(
  pin: string | undefined,
  listed: string | undefined,
  requested: readonly T[],
): readonly T[] {
  const pair = pin ?? listed;
  return pair ? requested.filter((a) => a.ticker === pair) : [];
}

function slugify(symbol: string, ticker: string): string {
  const s = symbol.toLowerCase().replace(/[^a-z0-9]+/g, "") || "token";
  return `${s}-${ticker.toLowerCase()}`;
}

/**
 * Slugs that name one pair each.
 *
 * A slug is built from the token's symbol, and a symbol is whatever its creator typed: two tokens can
 * both call themselves COTE. Left alone, `/terminal/cote-nvda` would open whichever had more
 * liquidity, so a copy with a deeper pool would take over the real token's links, and the swap panel
 * there would buy the copy. Where a slug is shared, every pair sharing it is named by its mint
 * instead, which nobody can copy.
 */
export function uniqueSlugs<
  T extends { slug: string; base: { mint: string }; quote: { ticker: string } },
>(pairs: readonly T[]): T[] {
  const uses = new Map<string, number>();
  for (const p of pairs) uses.set(p.slug, (uses.get(p.slug) ?? 0) + 1);
  return pairs.map((p) =>
    (uses.get(p.slug) ?? 0) > 1
      ? { ...p, slug: `${p.base.mint}-${p.quote.ticker.toLowerCase()}` }
      : p,
  );
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
 * Build the tradeable universe: every pair somebody chose, for tokens with real pool depth.
 */
export async function buildUniverse(opts?: {
  quotes?: string[];
  minLiquidityUsd?: number;
}): Promise<PairUniverse> {
  const [tokens, markets, cookUsd, rwaPrices, pinned, listed, launchedHere] = await Promise.all([
    fetchTokens(),
    fetchMarkets(),
    fetchCookPriceUsd(),
    fetchRwaPrices(),
    benchmarks(),
    listedByMint(),
    // The same cache the terminal's curve tabs read, so the two lists never disagree.
    cachedStale("coorwa-curves", 10_000, coorwaPairs).catch(() => [] as CoorwaCurvePair[]),
  ]);
  const onCoorwa = new Set(launchedHere.map((p) => p.base.mint));

  const minLiq = opts?.minLiquidityUsd ?? 1;
  const liqMap = liquidityByMint(markets);
  const mktMap = marketsByMint(markets);
  const tokenByMint = new Map(tokens.map((t) => [t.mint, t]));

  const quoteTickers = opts?.quotes?.length
    ? opts.quotes.map((q) => rwaByTicker(q)).filter((a): a is NonNullable<typeof a> => !!a)
    : RWA_ASSETS;

  const pairs: CoorwaPair[] = [];
  let skipped = 0;

  // Only mints that actually appear in a pool are tradeable, so the markets feed defines the set.
  for (const [mint, liquidityUsd] of liqMap) {
    if (liquidityUsd < minLiq) continue;
    // A token launched on Coorwa's curve is listed from its own pool below, never from the feed, so
    // its page stays the one that trades it directly and it is never listed twice.
    if (onCoorwa.has(mint)) continue;
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

    const pin = pinned.get(mint);

    for (const asset of quotesFor(pin, listed.get(mint), quoteTickers)) {
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
        pinned: pin != null,
        price: usd / rwa.priceUsd,
        inverse: rwa.priceUsd / usd,
        change24h: stale ? null : ratioChange(t.price?.change24h ?? null, rwa.change24h),
        venue: deepest?.type ?? null,
        poolId: deepest?.marketId ?? null,
      });
    }
  }

  // Coorwa's own tokens that have graduated, read from the pools the program opened, whether or not
  // any feed has indexed them yet.
  const wanted = new Set(quoteTickers.map((a) => a.ticker));
  for (const p of launchedHere) {
    const asset = rwaByTicker(p.quote.ticker);
    if (!p.pool || !asset || !wanted.has(asset.ticker) || p.priceUsd == null || p.price == null) continue;
    const liquidityUsd = p.pool.liquidityUsd ?? 0;
    if (liquidityUsd < minLiq) continue;
    pairs.push({
      slug: p.slug,
      base: {
        mint: p.base.mint,
        symbol: p.base.symbol,
        name: p.base.name,
        logo: p.base.logo,
        decimals: p.base.decimals,
        priceUsd: p.priceUsd,
        priceCook: cookUsd ? p.priceUsd / cookUsd : null,
        change24h: null,
        liquidityUsd,
        volume24h: null,
        marketCap: null,
        holders: null,
        stale: false,
      },
      quote: {
        ticker: asset.ticker,
        symbol: asset.symbol,
        mint: asset.mint,
        name: asset.name,
        logo: asset.logo,
        priceUsd: p.quote.priceUsd,
        change24h: p.quote.change24h,
      },
      pinned: true,
      price: p.price,
      inverse: p.inverse ?? 0,
      change24h: null,
      venue: "Coorwa pool",
      poolId: p.pool.address,
    });
  }

  pairs.sort((a, b) => b.base.liquidityUsd - a.base.liquidityUsd);
  await fillMissingLogos(pairs);

  return {
    pairs: uniqueSlugs(pairs),
    cookPriceUsd: cookUsd,
    rwa: Object.values(rwaPrices).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)),
    skipped,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The registry has no logo for some tokens, a graduated launchpad token among them, long after it
 * has a pool. Those are looked up the way lists of launchpad tokens do it: a logo stored earlier,
 * then the token's own metadata, found through its launchpad pool when it came from one.
 */
async function fillMissingLogos(pairs: CoorwaPair[]): Promise<void> {
  const missing = [...new Set(pairs.filter((p) => !p.base.logo).map((p) => p.base.mint))];
  if (missing.length === 0) return;
  const launchpad = await fetchPools("all").catch(() => []);
  const uris = new Map(launchpad.map((p) => [p.tokenMint, p.uri]));
  const logos = await logosByMint(missing.map((mint) => ({ mint, uri: uris.get(mint) })));
  for (const p of pairs) p.base.logo ??= logos.get(p.base.mint) ?? null;
}

/** Resolve a slug like "cookhouse-nvda", or "<mint>-nvda", to a single pair. */
export async function findPair(slug: string): Promise<CoorwaPair | null> {
  const idx = slug.lastIndexOf("-");
  if (idx < 1) return null;
  const ticker = slug.slice(idx + 1);
  const asset = rwaByTicker(ticker);
  if (!asset) return null;

  const universe = await buildUniverse({ quotes: [asset.ticker] });
  const want = slug.slice(0, idx).toLowerCase();
  // The mint first: a symbol is free text, so a token could name itself after another's mint.
  return (
    universe.pairs.find((p) => p.base.mint.toLowerCase() === want) ??
    universe.pairs.find((p) => p.slug === slug.toLowerCase()) ??
    null
  );
}

export { DEFAULT_RWA, COOK_MINT };
