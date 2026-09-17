import { NextResponse } from "next/server";
import { z } from "zod";
import { buildBuyTx, buildSellTx, buildClaimCreatorFeesTx } from "@/lib/launchpad";
import { ADDRESS_RE, COOK_DECIMALS, COORWA_REFERRER } from "@/lib/config";
import { uiToRaw } from "@/lib/format";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("buy"),
    wallet: z.string().regex(ADDRESS_RE, "not an address"),
    pool: z.string().regex(ADDRESS_RE, "not an address"),
    /** COOK to spend on the curve. */
    amount: z.number().positive(),
  }),
  z.object({
    action: z.literal("sell"),
    wallet: z.string().regex(ADDRESS_RE, "not an address"),
    pool: z.string().regex(ADDRESS_RE, "not an address"),
    /** Raw curve shares - these are program-tracked, not SPL tokens. */
    shares: z.string().regex(/^\d+$/),
  }),
  z.object({
    action: z.literal("claim-creator-fees"),
    wallet: z.string().regex(ADDRESS_RE, "not an address"),
    pool: z.string().regex(ADDRESS_RE, "not an address"),
  }),
]);

/**
 * Bonding-curve actions.
 *
 * Buys name Coorwa as referrer, which routes 20% of the launchpad's 1% trade fee into the cashback
 * pot. That share comes out of the same fee either way - with nobody named, the programme keeps it
 * - so this costs the buyer nothing. The programme rejects self-referral, so a wallet buying its
 * own curve is sent without one.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const b = parsed.data;

  try {
    if (b.action === "buy") {
      const referrer =
        COORWA_REFERRER && COORWA_REFERRER !== b.wallet ? COORWA_REFERRER : null;
      const built = await buildBuyTx({
        buyer: b.wallet,
        pool: b.pool,
        paymentAmount: uiToRaw(b.amount, COOK_DECIMALS),
        referrer,
      });
      return NextResponse.json({ ...built, referrer });
    }

    if (b.action === "sell") {
      return NextResponse.json(
        await buildSellTx({ seller: b.wallet, pool: b.pool, tokenShares: b.shares, unwrap: true }),
      );
    }

    return NextResponse.json(
      await buildClaimCreatorFeesTx({ creator: b.wallet, pool: b.pool, unwrap: true }),
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "build failed" },
      { status: 502 },
    );
  }
}
