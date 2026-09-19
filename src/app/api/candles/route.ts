import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchTrades,
  tradesToCandles,
  fetchRwaCandles,
  ratioCandles,
  INTERVAL_SECONDS,
} from "@/lib/candles";
import { rwaByTicker } from "@/lib/rwa";
import { curveFills } from "@/lib/curve-pairs";
import { ADDRESS_RE } from "@/lib/config";

export const dynamic = "force-dynamic";

const Query = z.object({
  mint: z.string().min(32).max(44),
  ticker: z.string().min(1).max(10),
  interval: z.enum(["5m", "15m", "1h", "4h", "1d"]).default("1h"),
  /** "ratio" charts the pair; "usd" charts the base token alone. */
  mode: z.enum(["ratio", "usd"]).default("ratio"),
  /** A bonding curve to chart instead of the pool feed, for a token that has not graduated. */
  pool: z.string().regex(ADDRESS_RE).optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { mint, ticker, interval, mode, pool } = parsed.data;

  const asset = rwaByTicker(ticker);
  if (!asset) return NextResponse.json({ error: `unknown RWA: ${ticker}` }, { status: 404 });

  try {
    const trades = pool ? await curveFills(pool, mint) : await fetchTrades(mint, 1000);
    const tokenCandles = tradesToCandles(trades, interval);

    if (mode === "usd") {
      return NextResponse.json({
        candles: tokenCandles,
        tradeCount: trades.length,
        mode,
        interval,
      });
    }

    const rwa = await fetchRwaCandles(asset.mint, interval, 400);
    const candles = ratioCandles(tokenCandles, rwa, INTERVAL_SECONDS[interval]);

    return NextResponse.json(
      {
        candles,
        tradeCount: trades.length,
        rwaCandleCount: rwa.length,
        mode,
        interval,
        ticker: asset.ticker,
      },
      { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load candles" },
      { status: 502 },
    );
  }
}
