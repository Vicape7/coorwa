import { NextResponse } from "next/server";
import { coorwaPairs } from "@/lib/coorwa-pairs";
import { cachedStale } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Every token on a Coorwa curve, as pairs.
 *
 * Read off the program rather than out of a feed, which costs one account scan and a read per
 * curve, so the answer is held briefly: the terminal asks for it on every refresh and the numbers
 * only move when somebody trades.
 */
export async function GET() {
  try {
    const pairs = await cachedStale("coorwa-curves", 10_000, coorwaPairs);
    return NextResponse.json(
      { pairs },
      { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load curves", pairs: [] },
      { status: 502 },
    );
  }
}
