import { NextResponse } from "next/server";
import { fetchMarkets, fetchTokens, fetchCookPriceUsd } from "@/lib/cookiescan";
import { fetchRwaPrices, type RwaQuote } from "@/lib/jupiter";
import { rwaByTicker } from "@/lib/rwa";
import { COOK_MINT, PROGRAM_IDS } from "@/lib/config";

export const dynamic = "force-dynamic";

export interface PoolRow {
  poolId: string;
  venue: string;
  /** True when Corwa can manage this position natively (Cookiebox DAMM v2). */
  manageable: boolean;
  base: { mint: string; symbol: string; logo: string | null; amount: number | null };
  quote: { mint: string; symbol: string; amount: number | null };
  liquidityUsd: number | null;
  /** Pool depth expressed in shares of the requested RWA. */
  liquidityShares: number | null;
  volume24h: number | null;
  liquidityDisplay: string | null;
}

/**
 * Every pool on Cookie Chain, with depth also expressed in shares of a real-world asset - the same
 * change of units the terminal applies to prices, so an LP can size a position the way they think
 * about it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker") ?? "NVDA";
  const asset = rwaByTicker(ticker);

  try {
    const [markets, tokens, cookUsd, rwa] = await Promise.all([
      fetchMarkets(),
      fetchTokens(),
      fetchCookPriceUsd(),
      fetchRwaPrices().catch((): Record<string, RwaQuote> => ({})),
    ]);

    const meta = new Map(tokens.map((t) => [t.mint, t]));
    const rwaPrice = asset ? rwa[asset.ticker]?.priceUsd : undefined;

    const rows: PoolRow[] = markets.map((m) => {
      // Corwa's LP tools build against the Cookiebox DAMM v2 program specifically.
      const manageable = /COOKIEBOX DAMM/i.test(m.type);
      const baseSide = m.baseToken?.mint === COOK_MINT ? m.quoteToken : m.baseToken;
      const quoteSide = m.baseToken?.mint === COOK_MINT ? m.baseToken : m.quoteToken;
      const baseMeta = meta.get(baseSide?.mint ?? "");

      return {
        poolId: m.marketId,
        venue: m.type,
        manageable,
        base: {
          mint: baseSide?.mint ?? "",
          symbol: baseSide?.symbol ?? baseMeta?.metadata?.symbol ?? "?",
          logo: baseMeta?.metadata?.logo ?? null,
          amount: baseSide?.amount ?? null,
        },
        quote: {
          mint: quoteSide?.mint ?? "",
          symbol: quoteSide?.symbol ?? "COOK",
          amount: quoteSide?.amount ?? null,
        },
        liquidityUsd: m.liquidityUsd ?? null,
        liquidityShares:
          rwaPrice && m.liquidityUsd != null ? m.liquidityUsd / rwaPrice : null,
        volume24h: baseMeta?.marketData?.volume24h ?? null,
        liquidityDisplay: m.liquidityDisplay ?? null,
      };
    });

    rows.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

    return NextResponse.json({
      pools: rows,
      count: rows.length,
      manageableCount: rows.filter((r) => r.manageable).length,
      cookPriceUsd: cookUsd,
      ticker: asset?.ticker ?? null,
      rwaPriceUsd: rwaPrice ?? null,
      dammProgramId: PROGRAM_IDS.cookieboxDamm,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load pools", pools: [] },
      { status: 502 },
    );
  }
}
