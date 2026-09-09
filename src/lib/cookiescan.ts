/** Cookiescan REST client: the Cookie Chain token registry and the markets/pools feed. */
import { COOKIESCAN_API, COOK_MINT } from "./config";
import { fetchJson, cachedStale } from "./http";

export interface CookiescanToken {
  mint: string;
  metadata?: {
    name?: string;
    symbol?: string;
    logo?: string;
    decimals?: number;
    description?: string;
    updateAuthority?: string;
    socials?: Record<string, string>;
  };
  price?: { usd?: number; native?: number; change24h?: number };
  marketData?: {
    volume24h?: number;
    volumeChange24h?: number;
    liquidity?: number;
    marketCap?: number;
    supply?: number;
    holderCount?: number;
  };
  lastUpdated?: string;
}

export interface CookiescanMarketSide {
  mint: string;
  symbol?: string;
  amount?: number;
  priceUsd?: number;
}

export interface CookiescanMarket {
  marketId: string;
  /** Venue label, e.g. "COOKIEBOX DAMM", "COOKIESWAP CPAMM", "COOKIEBOX CLMM". */
  type: string;
  baseToken: CookiescanMarketSide;
  quoteToken: CookiescanMarketSide;
  liquidityUsd?: number;
  liquidityDisplay?: string;
}

function unwrap<T>(json: unknown, keys: string[]): T[] {
  if (Array.isArray(json)) return json as T[];
  for (const k of keys) {
    const v = (json as Record<string, unknown>)?.[k];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

/** The full registry is ~6.5k mints and ~4MB, so it is cached hard and never sent to the client. */
export async function fetchTokens(): Promise<CookiescanToken[]> {
  return cachedStale("cookiescan:tokens", 60_000, async () =>
    unwrap<CookiescanToken>(await fetchJson<unknown>(`${COOKIESCAN_API}/api/tokens`, { timeoutMs: 30_000 }), [
      "data",
      "tokens",
    ]),
  );
}

export async function fetchMarkets(): Promise<CookiescanMarket[]> {
  return cachedStale("cookiescan:markets", 30_000, async () =>
    unwrap<CookiescanMarket>(await fetchJson<unknown>(`${COOKIESCAN_API}/api/markets`, { timeoutMs: 20_000 }), [
      "data",
      "markets",
    ]),
  );
}

/** COOK's USD price - the hinge between Cookie Chain prices and RWA prices. */
export async function fetchCookPriceUsd(): Promise<number | null> {
  return cachedStale("cookiescan:cookprice", 20_000, async () => {
    const j = await fetchJson<{ data?: { price?: { usd?: number } } }>(
      `${COOKIESCAN_API}/api/price/cook`,
    );
    const usd = j?.data?.price?.usd;
    return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : null;
  });
}

/**
 * Total USD liquidity per mint, summed across every pool it appears in.
 *
 * The registry's own `marketData.liquidity` is ambiguous about its unit, so Corwa derives depth
 * from the markets feed instead, where `liquidityUsd` is stated per pool.
 */
export function liquidityByMint(markets: CookiescanMarket[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of markets) {
    const usd = m.liquidityUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) continue;
    for (const side of [m.baseToken, m.quoteToken]) {
      if (!side?.mint || side.mint === COOK_MINT) continue;
      out.set(side.mint, (out.get(side.mint) ?? 0) + usd);
    }
  }
  return out;
}

/** Every pool a mint trades in, deepest first. */
export function marketsByMint(markets: CookiescanMarket[]): Map<string, CookiescanMarket[]> {
  const out = new Map<string, CookiescanMarket[]>();
  for (const m of markets) {
    for (const side of [m.baseToken, m.quoteToken]) {
      if (!side?.mint || side.mint === COOK_MINT) continue;
      const list = out.get(side.mint) ?? [];
      list.push(m);
      out.set(side.mint, list);
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  }
  return out;
}
