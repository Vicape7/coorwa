import { NextResponse } from "next/server";
import { buildUniverse } from "@/lib/pairs";
import { CoorwaError } from "@/lib/http";

export const revalidate = 0;
export const dynamic = "force-dynamic";

/**
 * The tradeable universe. Upstream reads are cached in-process, so this stays cheap even though it
 * fans out to a 4MB registry, a markets feed and 16 Jupiter lookups.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const quote = url.searchParams.get("quote");
  const minLiq = Number(url.searchParams.get("minLiquidity") ?? "1");

  try {
    const universe = await buildUniverse({
      quotes: quote ? quote.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      minLiquidityUsd: Number.isFinite(minLiq) ? minLiq : 1,
    });
    return NextResponse.json(universe, {
      headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" },
    });
  } catch (e) {
    const err = e instanceof CoorwaError ? e : null;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to build universe", hint: err?.hint },
      { status: 502 },
    );
  }
}
