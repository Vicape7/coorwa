import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchTrades } from "@/lib/candles";

export const dynamic = "force-dynamic";

const Query = z.object({
  mint: z.string().min(32).max(44),
  limit: z.coerce.number().int().min(1).max(500).default(120),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid query" }, { status: 400 });
  }

  try {
    const trades = await fetchTrades(parsed.data.mint, parsed.data.limit);
    return NextResponse.json(
      { trades: trades.slice(0, parsed.data.limit) },
      { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load trades", trades: [] },
      { status: 502 },
    );
  }
}
