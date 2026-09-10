import { NextResponse } from "next/server";
import { z } from "zod";
import { EpochError, recordClaim } from "@/lib/epochs";

export const dynamic = "force-dynamic";

const Body = z.object({
  signature: z.string().min(64).max(128),
  wallet: z.string().min(32).max(44),
  epoch: z.union([z.string(), z.number()]),
});

/**
 * Note down a claim that already happened on chain.
 *
 * Nothing depends on this call. The vault's own claim record is what stops a second attempt, and
 * `/api/cashback/claimable` reads that record every time, so a claim whose report never arrives
 * still shows as claimed. What this adds is the signature, which the on-chain record does not
 * carry, so the claimant keeps a link to their own transaction.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  let epoch: bigint;
  try {
    epoch = BigInt(parsed.data.epoch);
  } catch {
    return NextResponse.json({ error: "that is not an epoch index" }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await recordClaim({ signature: parsed.data.signature, wallet: parsed.data.wallet, epoch }),
    );
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not record the claim" },
      { status },
    );
  }
}
