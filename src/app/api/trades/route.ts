import { NextResponse } from "next/server";
import { z } from "zod";
import { coorwaFills, curveFills, tokenFills } from "@/lib/chain-fills";
import { ADDRESS_RE } from "@/lib/config";

export const dynamic = "force-dynamic";

const Query = z.object({
  mint: z.string().min(32).max(44),
  limit: z.coerce.number().int().min(1).max(500).default(120),
  /** A bonding curve whose fills to list instead of the pool feed's. */
  pool: z.string().regex(ADDRESS_RE).optional(),
  /** Whose curve: the launchpad indexes its own, Coorwa reads its program's events. */
  venue: z.enum(["momoswap", "coorwa"]).default("momoswap"),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid query" }, { status: 400 });
  }

  try {
    const { mint, limit, pool, venue } = parsed.data;
    const trades =
      venue === "coorwa"
        ? await coorwaFills(mint)
        : pool
          ? await curveFills(pool, mint)
          : await tokenFills(mint, limit);
    return NextResponse.json(
      { trades: trades.slice(0, limit) },
      { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load trades", trades: [] },
      { status: 502 },
    );
  }
}
