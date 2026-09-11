import { NextResponse } from "next/server";
import { z } from "zod";
import { planCrossChainSell } from "@/lib/crosschain";
import { fetchRwaPrices, type RwaQuote } from "@/lib/jupiter";
import { CoorwaError } from "@/lib/http";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/config";

export const dynamic = "force-dynamic";

const Query = z.object({
  ticker: z.string().min(1).max(10),
  /**
   * Raw units, as a decimal string. Deliberately not a share count: xStocks rebase, so only the
   * holder's token account knows what a displayed balance is worth in raw units.
   */
  amountRaw: z.string().regex(/^[0-9]+$/, "amountRaw must be raw integer units"),
  shares: z.coerce.number().positive(),
  outputMint: z.string().min(32).max(44),
  outputSymbol: z.string().min(1).max(32),
  outputDecimals: z.coerce.number().int().min(0).max(18),
  slippageBps: z.coerce.number().int().min(1).max(5000).default(DEFAULT_SLIPPAGE_BPS),
  owner: z.string().min(32).max(44).optional(),
});

/** Price the full xStock -> COOK -> bridge -> TOKEN route, with real per-leg slippage. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const [plan, prices] = await Promise.all([
      planCrossChainSell(parsed.data),
      fetchRwaPrices().catch((): Record<string, RwaQuote> => ({})),
    ]);
    const price = prices[plan.asset.ticker]?.priceUsd;
    return NextResponse.json({
      ...plan,
      inputUsd: price ? plan.input.shares * price : 0,
      // The raw Jupiter quote is large and only the executor needs it back verbatim.
      solanaQuote: undefined,
    });
  } catch (e) {
    const err = e instanceof CoorwaError ? e : null;
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "could not plan route",
        hint: err?.hint,
      },
      { status: 502 },
    );
  }
}
