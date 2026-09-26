import { NextResponse } from "next/server";
import { findCoorwaPair } from "@/lib/coorwa-pairs";

export const dynamic = "force-dynamic";

/** The live state of a pair on Coorwa's own curve: reserves, price, and how far the raise has come. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  try {
    const pair = await findCoorwaPair(slug);
    if (!pair) return NextResponse.json({ error: `no such curve: ${slug}` }, { status: 404 });
    return NextResponse.json(pair, {
      headers: { "cache-control": "public, s-maxage=5, stale-while-revalidate=20" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load the curve" },
      { status: 502 },
    );
  }
}
