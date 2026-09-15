import { NextResponse } from "next/server";
import { z } from "zod";
import { type VersionedTransactionResponse } from "@solana/web3.js";
import { recordFill, launchpadReferralFee } from "@/lib/cashback";
import { fetchCookPriceUsd } from "@/lib/cookiescan";
import { proveTransaction, isProven, tokenCredited } from "@/lib/onchain";
import { vaultFundsAccount } from "@/lib/swap-fee";
import { tokenCreator } from "@/lib/creators";
import { carriesBenchmark } from "@/lib/listings";
import { COOK_DECIMALS, COOK_MINT, COORWA_REFERRER, COORWA_SWAP_FEE_BPS } from "@/lib/config";

export const dynamic = "force-dynamic";

const Body = z.object({
  signature: z.string().min(64).max(128),
  wallet: z.string().min(32).max(44),
  source: z.enum(["swap", "launchpad"]),
  mint: z.string().min(32).max(44),
  /** The benchmark of the pair traded on, for a swap made on a pair. */
  ticker: z.string().min(1).max(10).optional(),
  symbol: z.string().max(32).optional(),
  side: z.enum(["buy", "sell"]),
  valueUsd: z.number().nonnegative().max(1e9),
  feeUsd: z.number().nonnegative().max(1e7),
  creator: z.string().min(32).max(44).optional(),
  chain: z.enum(["cookie", "solana"]).default("cookie"),
});

/**
 * What the fee payer's COOK balance actually did, in UI units and always positive.
 *
 * COOK is Cookie Chain's native unit, so a curve trade shows up as a plain lamport movement on the
 * payer. The network fee is added back because it is not part of the trade.
 */
function cookMoved(tx: VersionedTransactionResponse, side: "buy" | "sell"): number | null {
  const pre = tx.meta?.preBalances?.[0];
  const post = tx.meta?.postBalances?.[0];
  if (typeof pre !== "number" || typeof post !== "number") return null;

  const fee = tx.meta?.fee ?? 0;
  const moved = side === "buy" ? pre - post - fee : post - pre + fee;
  return moved > 0 ? moved / 10 ** COOK_DECIMALS : 0;
}

/**
 * Report a confirmed fill for cashback accrual.
 *
 * A client could otherwise claim any trade it liked, so the transaction is proved against the chain
 * before anything is written. Combined with the unique index on the signature, that makes the
 * accrual table an index of provable events rather than a claim log.
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
    const proof = await proveTransaction({
      signature: b.signature,
      wallet: b.wallet,
      chain: b.chain,
    });
    if (!isProven(proof)) {
      return NextResponse.json({ error: proof.error, recorded: false }, { status: proof.status });
    }

    // Neither the size of a trade nor the fee it earned is taken on the client's word, whichever
    // path it came from. Both are re-derived from what the transaction actually did.
    const cookPriceUsd = await fetchCookPriceUsd();
    let valueUsd = b.valueUsd;
    let feeUsd = 0;

    if (b.source === "launchpad") {
      const moved = cookMoved(proof.tx, b.side);
      if (cookPriceUsd && moved != null) {
        // Rent for a token account the buy had to open moves in the same balance, so this is a
        // ceiling on the trade rather than the trade itself, which is all it has to be.
        valueUsd = Math.min(valueUsd, moved * cookPriceUsd);
      }
      // MomoSwap pays the referral share only to an address named on the transaction, and it names
      // it as an account. Not there, no revenue, so nothing to rebate.
      feeUsd =
        COORWA_REFERRER && proof.accounts.has(COORWA_REFERRER) ? launchpadReferralFee(valueUsd) : 0;
    } else {
      // A swap earns only what the transaction actually paid the vault. A route too long to carry
      // the fee instruction goes through without one, and that fill is worth exactly zero here.
      const paid = tokenCredited(proof, vaultFundsAccount().toBase58(), COOK_MINT);
      if (cookPriceUsd && paid != null && paid > 0n) {
        feeUsd = (Number(paid) / 10 ** COOK_DECIMALS) * cookPriceUsd;
        // The fee is a fixed share of the COOK leg, so it also proves the size of the trade. Listing
        // fees are shared out by what each wallet paid on a pair, and a size reported by the client
        // would let anyone claim a bigger share than they traded for.
        valueUsd = (feeUsd * 10_000) / COORWA_SWAP_FEE_BPS;
      }
    }

    // A pair the token does not carry is dropped rather than refused: the fill still accrues its
    // fee, it just does not count towards any pair's listing fees.
    const ticker =
      b.ticker && (await carriesBenchmark(b.mint, b.ticker)) ? b.ticker.toUpperCase() : null;

    // Resolved here rather than sent, so a client cannot name whoever it likes as the creator and
    // route somebody else's share to them.
    const creator = (await tokenCreator(b.mint))?.wallet ?? null;

    const res = await recordFill({
      ...b,
      ticker,
      valueUsd,
      feeUsd,
      creator: creator ?? undefined,
    });
    return NextResponse.json({
      ...res,
      valueUsd,
      feeUsd,
      ticker,
      creator,
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
