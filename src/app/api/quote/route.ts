import { NextResponse } from "next/server";
import { z } from "zod";
import { bestQuote } from "@/lib/swap";
import { CorwaError } from "@/lib/http";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/config";

export const dynamic = "force-dynamic";

const Query = z.object({
  inputMint: z.string().min(32).max(44),
  outputMint: z.string().min(32).max(44),
  amount: z.string().regex(/^\d+$/, "amount must be a raw integer"),
  slippageBps: z.coerce.number().int().min(1).max(5000).default(DEFAULT_SLIPPAGE_BPS),
  owner: z.string().min(32).max(44).optional(),
});

/** Quote both Cookie Chain routers and return the better fill, plus the loser for comparison. */
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
    const { best, all } = await bestQuote(parsed.data);
    return NextResponse.json({ best, all });
  } catch (e) {
    const err = e instanceof CorwaError ? e : null;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "quote failed", hint: err?.hint },
      { status: err?.status === 404 ? 404 : 502 },
    );
  }
}
