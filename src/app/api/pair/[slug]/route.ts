import { NextResponse } from "next/server";
import { findPair } from "@/lib/pairs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  try {
    const pair = await findPair(slug);
    if (!pair) {
      return NextResponse.json({ error: `no such pair: ${slug}` }, { status: 404 });
    }
    return NextResponse.json(pair, {
      headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load pair" },
      { status: 502 },
    );
  }
}
