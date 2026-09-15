import { NextResponse } from "next/server";
import { fetchRwaPrices } from "@/lib/jupiter";

export const dynamic = "force-dynamic";

/** USD price per xStock, keyed by ticker. Feeds the rewards calculator on the landing page. */
export async function GET() {
  try {
    const quotes = await fetchRwaPrices();
    const prices = Object.fromEntries(
      Object.values(quotes).map((q) => [q.ticker, q.priceUsd] as const),
    );
    return NextResponse.json(
      { prices },
      { headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" } },
    );
  } catch (e) {
    return NextResponse.json(
      { prices: {}, error: e instanceof Error ? e.message : "unavailable" },
      { status: 502 },
    );
  }
}
