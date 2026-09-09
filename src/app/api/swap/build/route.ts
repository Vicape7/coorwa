import { NextResponse } from "next/server";
import { z } from "zod";
import { buildCookieboxTx, buildCandyshopTx } from "@/lib/swap";
import { CorwaError } from "@/lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  aggregator: z.enum(["cookiebox", "candyshop"]),
  owner: z.string().min(32).max(44),
  inputMint: z.string().min(32).max(44),
  outputMint: z.string().min(32).max(44),
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(1).max(5000),
  /** Candy Shop needs its own quote object handed back verbatim. */
  raw: z.unknown().optional(),
});

/**
 * Build an unsigned swap transaction.
 *
 * Both aggregators re-quote server-side and return a transaction the user's wallet signs. Corwa
 * never sees a private key and never co-signs - this route is a proxy that keeps the upstream
 * call server-side, where rate limits and CORS are not the browser's problem.
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

  try {
    if (b.aggregator === "cookiebox") {
      const tx = await buildCookieboxTx({
        inputMint: b.inputMint,
        outputMint: b.outputMint,
        amount: b.amount,
        slippageBps: b.slippageBps,
        owner: b.owner,
      });
      return NextResponse.json({
        aggregator: "cookiebox",
        transactionBase64: tx.transactionBase64,
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
      transactionBase64: tx.transactionBase64,
    });
  } catch (e) {
    const err = e instanceof CorwaError ? e : null;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "build failed", hint: err?.hint },
      { status: 502 },
    );
  }
}
