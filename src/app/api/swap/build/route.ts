import { NextResponse } from "next/server";
import { z } from "zod";
import { buildCookieboxTx, buildCandyshopTx } from "@/lib/swap";
import { attachSwapFee, cookLeg } from "@/lib/swap-fee";
import { CoorwaError } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  aggregator: z.enum(["cookiebox", "candyshop"]),
  owner: z.string().min(32).max(44),
  inputMint: z.string().min(32).max(44),
  outputMint: z.string().min(32).max(44),
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(1).max(5000),
  /** The quoted output, so the fee on a sell can be taken on the COOK the trade will produce. */
  outAmount: z.string().regex(/^\d+$/).optional(),
  /** Candy Shop needs its own quote object handed back verbatim. */
  raw: z.unknown().optional(),
});

/**
 * Build an unsigned swap transaction.
 *
 * Both aggregators re-quote server-side and return a transaction the user's wallet signs. Coorwa
 * never sees a private key and never co-signs - this route is a proxy that keeps the upstream
 * call server-side, where rate limits and CORS are not the browser's problem.
 *
 * Coorwa's own fee is appended here rather than in the browser, so it cannot be dropped by editing
 * the client. It is a visible instruction paying the cashback vault, and the amount charged is
 * returned alongside the transaction so the panel can show it before anybody signs.
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
  const b = parsed.data;

  // Charged on whichever side is COOK, which is every pair in the terminal.
  const leg = cookLeg(b.inputMint, b.outputMint, b.amount, b.outAmount ?? "0");

  try {
    if (b.aggregator === "cookiebox") {
      const tx = await buildCookieboxTx({
        inputMint: b.inputMint,
        outputMint: b.outputMint,
        amount: b.amount,
        slippageBps: b.slippageBps,
        owner: b.owner,
      });
      const priced = attachSwapFee(tx.transactionBase64, b.owner, leg);
      return NextResponse.json({
        aggregator: "cookiebox",
        ...priced,
        blockhash: tx.blockhash,
        lastValidBlockHeight: tx.lastValidBlockHeight,
      });
    }

    if (!b.raw) {
      return NextResponse.json(
        { error: "candyshop builds need the quote's `raw` route echoed back" },
        { status: 400 },
      );
    }
    const tx = await buildCandyshopTx(b.raw, b.owner);
    return NextResponse.json({
      aggregator: "candyshop",
      ...attachSwapFee(tx.transactionBase64, b.owner, leg),
    });
  } catch (e) {
    const err = e instanceof CoorwaError ? e : null;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "build failed", hint: err?.hint },
      { status: 502 },
    );
  }
}
