import { NextResponse } from "next/server";
import { z } from "zod";
import { Connection } from "@solana/web3.js";
import { recordFill } from "@/lib/cashback";
import { COOKIE_RPC_URL, SOLANA_RPC_URL } from "@/lib/config";

export const dynamic = "force-dynamic";

const Body = z.object({
  signature: z.string().min(64).max(128),
  wallet: z.string().min(32).max(44),
  source: z.enum(["swap", "launchpad"]),
  mint: z.string().min(32).max(44),
  symbol: z.string().max(32).optional(),
  side: z.enum(["buy", "sell"]),
  valueUsd: z.number().nonnegative().max(1e9),
  feeUsd: z.number().nonnegative().max(1e7),
  creator: z.string().min(32).max(44).optional(),
  chain: z.enum(["cookie", "solana"]).default("cookie"),
});

/**
 * Report a confirmed fill for cashback accrual.
 *
 * A client could otherwise claim any trade it liked, so the signature is verified against the chain
 * before anything is written: the transaction must exist, must have succeeded, and must have been
 * signed by the wallet being credited. Combined with the unique index on the signature, that makes
 * the accrual table an index of provable events rather than a claim log.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const b = parsed.data;

  try {
    const conn = new Connection(b.chain === "solana" ? SOLANA_RPC_URL : COOKIE_RPC_URL, "confirmed");
    const tx = await conn.getTransaction(b.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx) {
      return NextResponse.json(
        { error: "that transaction was not found on chain", recorded: false },
        { status: 404 },
      );
    }
    if (tx.meta?.err) {
      return NextResponse.json(
        { error: "that transaction failed on chain", recorded: false },
        { status: 409 },
      );
    }

    // The fee payer is the first signer; crediting anyone else would let a caller credit a stranger.
    const signer = tx.transaction.message.getAccountKeys().get(0)?.toBase58();
    if (signer !== b.wallet) {
      return NextResponse.json(
        { error: "that transaction was not signed by this wallet", recorded: false },
        { status: 403 },
      );
    }

    const res = await recordFill(b);
    return NextResponse.json({
      ...res,
      note: res.recorded
        ? undefined
        : "cashback accounting is not configured on this deployment (no DATABASE_URL)",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not record the fill", recorded: false },
      { status: 502 },
    );
  }
}
