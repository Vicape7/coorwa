import { NextResponse } from "next/server";
import { fetchMarkets, marketsByMint, type CookiescanMarket } from "@/lib/cookiescan";
import { buildUniverse } from "@/lib/pairs";
import { COOK_MINT, PROGRAM_IDS } from "@/lib/config";

export const dynamic = "force-dynamic";

export interface PoolRow {
  /** The pair's terminal slug, e.g. "cookhouse-nvda". One row per pair, so a key. */
  slug: string;
  poolId: string;
  venue: string;
  /** True when Coorwa can manage this position natively (Cookiebox DAMM v2). */
  manageable: boolean;
  base: { mint: string; symbol: string; logo: string | null; amount: number | null };
  /** The pool's other side, COOK. What a deposit is actually paired with. */
  quote: { mint: string; symbol: string; amount: number | null };
  /** The asset the pair is quoted in. */
  rwa: { ticker: string; symbol: string; logo: string; priceUsd: number };
  /** True when this asset was picked by the token's creator at launch rather than bought later. */
  pinned: boolean;
  liquidityUsd: number | null;
  /** Pool depth expressed in shares of the pair's own asset. */
  liquidityShares: number | null;
  volume24h: number | null;
  /** 24h move of the pair's ratio, null when the token did not trade. */
  change24h: number | null;
  liquidityDisplay: string | null;
}

const isDamm = (m: CookiescanMarket) => /COOKIEBOX DAMM/i.test(m.type);
const hasCook = (m: CookiescanMarket) =>
  m.baseToken?.mint === COOK_MINT || m.quoteToken?.mint === COOK_MINT;

/**
 * The pool an LP should deposit into for a token: the deepest Cookiebox DAMM v2 pool against COOK,
 * because that is the one Coorwa can build positions for. Failing that, the deepest pool at all, shown
 * view-only so the pair is not hidden just because its liquidity lives on another venue.
 */
function poolFor(pools: CookiescanMarket[]): CookiescanMarket | null {
  return pools.find((m) => isDamm(m) && hasCook(m)) ?? pools[0] ?? null;
}

/**
 * The pairs somebody chose, each with the real pool behind it.
 *
 * A TOKEN/RWA pair has no pool of its own and cannot have one on Cookie Chain. What an LP provides is
 * the token's COOK pool, which is what every trade on the pair actually goes through. So this lists
 * exactly the pairs the terminal lists, and names the pool a deposit lands in. A token with two pairs
 * appears twice, against the same pool.
 */
export async function GET() {
  try {
    const [universe, markets] = await Promise.all([buildUniverse(), fetchMarkets()]);
    const byMint = marketsByMint(markets);

    const rows: PoolRow[] = [];
    for (const p of universe.pairs) {
      const m = poolFor(byMint.get(p.base.mint) ?? []);
      if (!m) continue;
      const baseSide = m.baseToken?.mint === p.base.mint ? m.baseToken : m.quoteToken;
      const otherSide = m.baseToken?.mint === p.base.mint ? m.quoteToken : m.baseToken;

      rows.push({
        slug: p.slug,
        poolId: m.marketId,
        venue: m.type,
        manageable: isDamm(m),
        base: {
          mint: p.base.mint,
          symbol: p.base.symbol,
          logo: p.base.logo,
          amount: baseSide?.amount ?? null,
        },
        quote: {
          mint: otherSide?.mint ?? "",
          symbol: otherSide?.symbol ?? "COOK",
          amount: otherSide?.amount ?? null,
        },
        rwa: {
          ticker: p.quote.ticker,
          symbol: p.quote.symbol,
          logo: p.quote.logo,
          priceUsd: p.quote.priceUsd,
        },
        pinned: p.pinned,
        liquidityUsd: m.liquidityUsd ?? null,
        liquidityShares:
          m.liquidityUsd != null && p.quote.priceUsd > 0 ? m.liquidityUsd / p.quote.priceUsd : null,
        volume24h: p.base.volume24h,
        change24h: p.change24h,
        liquidityDisplay: m.liquidityDisplay ?? null,
      });
    }

    rows.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

    return NextResponse.json({
      pools: rows,
      count: rows.length,
      manageableCount: rows.filter((r) => r.manageable).length,
      cookPriceUsd: universe.cookPriceUsd,
      dammProgramId: PROGRAM_IDS.cookieboxDamm,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load pools", pools: [] },
      { status: 502 },
    );
  }
}
