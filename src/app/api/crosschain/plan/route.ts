import { NextResponse } from "next/server";
import { z } from "zod";
import { planCrossChainBuy } from "@/lib/crosschain";
import { fetchRwaPrices, type RwaQuote } from "@/lib/jupiter";
import { CoorwaError } from "@/lib/http";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/config";

export const dynamic = "force-dynamic";

const Query = z.object({
  inputMint: z.string().min(32).max(44),
  inputSymbol: z.string().min(1).max(32),
  inputDecimals: z.coerce.number().int().min(0).max(18),
  amount: z.coerce.number().positive(),
  ticker: z.string().min(1).max(10),
  slippageBps: z.coerce.number().int().min(1).max(5000).default(DEFAULT_SLIPPAGE_BPS),
  owner: z.string().min(32).max(44).optional(),
});

/** Price the full TOKEN -> COOK -> bridge -> xStock route, with real per-leg slippage. */
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
      planCrossChainBuy(parsed.data),
      fetchRwaPrices().catch((): Record<string, RwaQuote> => ({})),
    ]);
    const price = prices[plan.asset.ticker]?.priceUsd;
    return NextResponse.json({
      ...plan,
      outputUsd: price ? plan.outputShares * price : 0,
      // The raw Jupiter quote is large and only the executor needs it back verbatim.
      solanaQuote: undefined,
    });
  } catch (e) {
    const err = e instanceof CoorwaError ? e : null;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not plan route", hint: err?.hint },
      { status: 502 },
    );
  }
}
