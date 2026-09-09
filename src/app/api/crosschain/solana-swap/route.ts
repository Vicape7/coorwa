import { NextResponse } from "next/server";
import { z } from "zod";
import { jupQuote, jupSwapTx, routeLabels } from "@/lib/jupiter";
import { rwaByTicker } from "@/lib/rwa";
import { COOK_SOLANA_MINT, COOK_SOLANA_DECIMALS, DEFAULT_SLIPPAGE_BPS } from "@/lib/config";
import { uiToRaw } from "@/lib/format";
import { CorwaError } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  ticker: z.string().min(1).max(10),
  /** UI amount of bridged COOK to spend on Solana. */
  amount: z.number().positive(),
  owner: z.string().min(32).max(44),
  slippageBps: z.number().int().min(1).max(5000).default(DEFAULT_SLIPPAGE_BPS),
  /** "sell" swaps the xStock back into COOK for the return trip. */
  direction: z.enum(["buy", "sell"]).default("buy"),
});

/**
 * Leg 3 of a cross-chain route: swap bridged COOK into the xStock on Solana mainnet (or back).
 *
 * Jupiter returns a fully built transaction carrying its own blockhash, so the client signs and
 * sends it against a Solana connection without Corwa ever touching a key.
 */
export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { ticker, amount, owner, slippageBps, direction } = parsed.data;

  const asset = rwaByTicker(ticker);
  if (!asset) return NextResponse.json({ error: `unknown RWA: ${ticker}` }, { status: 404 });

  try {
    const inputMint = direction === "buy" ? COOK_SOLANA_MINT : asset.mint;
    const outputMint = direction === "buy" ? asset.mint : COOK_SOLANA_MINT;
    const decimals = direction === "buy" ? COOK_SOLANA_DECIMALS : asset.decimals;

    const quote = await jupQuote({
      inputMint,
      outputMint,
      amount: uiToRaw(amount, decimals),
      slippageBps,
    });

    const built = await jupSwapTx({ quoteResponse: quote, userPublicKey: owner });

    return NextResponse.json({
      transactionBase64: built.swapTransaction,
      lastValidBlockHeight: built.lastValidBlockHeight,
      outAmount: quote.outAmount,
      outDecimals: direction === "buy" ? asset.decimals : COOK_SOLANA_DECIMALS,
      priceImpactPct: Number(quote.priceImpactPct) * 100,
      route: routeLabels(quote),
    });
  } catch (e) {
    const err = e instanceof CorwaError ? e : null;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "solana leg failed", hint: err?.hint },
      { status: 502 },
    );
  }
}
