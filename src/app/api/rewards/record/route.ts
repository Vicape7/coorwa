import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { recordFill } from "@/lib/cashback";
import { fetchCookPriceUsd, fetchTokens } from "@/lib/cookiescan";
import {
  isProven,
  lamportsCredited,
  proveTransaction,
  tokenCredited,
  tokenMoved,
  tradesOnCurve,
  type ProvenTransaction,
} from "@/lib/onchain";
import { tokenCreator } from "@/lib/creators";
import { carriesBenchmark, signatureSpent } from "@/lib/listings";
import { fetchPool } from "@/lib/launchpad";
import {
  ADDRESS_RE,
  COOK_DECIMALS,
  COOK_MINT,
  COORWA_OPERATOR,
  COORWA_REFERRER,
  COORWA_SWAP_FEE_BPS,
  MOMOSWAP_REFERRAL_SHARE,
  MOMOSWAP_TRADE_FEE_BPS,
} from "@/lib/config";

export const dynamic = "force-dynamic";

const Body = z.object({
  signature: z.string().min(64).max(128),
  wallet: z.string().regex(ADDRESS_RE, "not an address"),
  source: z.enum(["swap", "launchpad"]),
  mint: z.string().regex(ADDRESS_RE, "not an address"),
  /** The curve the trade happened on. Launchpad fills only, where shares are not SPL tokens. */
  pool: z.string().regex(ADDRESS_RE, "not an address").optional(),
  /** The benchmark of the pair traded on, for a swap made on a pair. */
  ticker: z.string().min(1).max(10).optional(),
  side: z.enum(["buy", "sell"]),
});

/** Raw COOK as dollars. */
const cookUsd = (raw: bigint, priceUsd: number) => (Number(raw) / 10 ** COOK_DECIMALS) * priceUsd;

/** The wrapped COOK account the launchpad pays a referrer into. */
function wrappedCookAccount(owner: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(COOK_MINT), new PublicKey(owner)).toBase58();
}

/** The token's symbol as the chain's own registry has it. Never taken from the caller. */
async function registrySymbol(mint: string): Promise<string | null> {
  const tokens = await fetchTokens().catch(() => []);
  return tokens.find((t) => t.mint === mint)?.metadata?.symbol?.trim() || null;
}

/**
 * What a swap on Coorwa earned, and proof that it was a swap of this token.
 *
 * Two things have to hold, and neither is taken from the caller. The fee payer's balance of the
 * token has to have moved on this transaction, which is what ties the fill to a token instead of
 * letting a caller name whichever one pays them best. And the fee is whatever COOK the transaction
 * really put into the operator wallet, which is zero for a route too long to carry the fee.
 */
function swapFill(
  proof: ProvenTransaction,
  wallet: string,
  mint: string,
  cookPriceUsd: number | null,
) {
  const moved = tokenMoved(proof, wallet, mint);
  if (moved === 0n) return null;

  const paid = COORWA_OPERATOR ? lamportsCredited(proof, COORWA_OPERATOR) : null;
  const feeUsd = cookPriceUsd && paid && paid > 0n ? cookUsd(paid, cookPriceUsd) : 0;
  return {
    side: moved > 0n ? ("buy" as const) : ("sell" as const),
    feeUsd,
    // The fee is a fixed share of the COOK leg, so it also sizes the trade.
    valueUsd: feeUsd ? (feeUsd * 10_000) / COORWA_SWAP_FEE_BPS : 0,
  };
}

/**
 * What a curve trade earned, and proof that it was a trade on this token's curve.
 *
 * Curve shares are tracked by the launchpad rather than held as SPL tokens, so there is no balance
 * to read. Instead the transaction has to carry the launchpad's own buy or sell over this pool, and
 * the launchpad has to agree that the pool belongs to this mint. The referral is then measured as
 * the wrapped COOK that actually reached Coorwa's referrer account, rather than worked out from the
 * size of the trade: a transaction that merely names the referrer has paid it nothing.
 */
async function launchpadFill(
  proof: ProvenTransaction,
  mint: string,
  pool: string,
  cookPriceUsd: number | null,
) {
  if (!tradesOnCurve(proof, pool)) return null;

  const curve = await fetchPool(pool).catch(() => null);
  if (!curve || curve.tokenMint !== mint) return null;

  const referralRaw = COORWA_REFERRER
    ? tokenCredited(proof, wrappedCookAccount(COORWA_REFERRER), COOK_MINT)
    : null;
  const feeUsd =
    cookPriceUsd && referralRaw && referralRaw > 0n ? cookUsd(referralRaw, cookPriceUsd) : 0;
  const share = (MOMOSWAP_TRADE_FEE_BPS / 10_000) * MOMOSWAP_REFERRAL_SHARE;
  return { feeUsd, valueUsd: share > 0 ? feeUsd / share : 0, symbol: curve.symbol };
}

/**
 * Report a confirmed fill for holder rewards.
 *
 * Nothing here is a claim. The transaction is read back from the chain, has to have been signed by
 * the wallet reporting it, has to be a trade of the token being named, and the fee it earned is
 * measured on the transaction itself. Combined with the unique index on the signature, that makes
 * the fills table an index of provable events rather than a log of what clients said happened.
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
    const proof = await proveTransaction({ signature: b.signature, wallet: b.wallet });
    if (!isProven(proof)) {
      return NextResponse.json({ error: proof.error, recorded: false }, { status: proof.status });
    }

    // A pair payment is already the token's income, in `listings`. Counting it again here would pay
    // its holders twice for one dollar.
    if (await signatureSpent(b.signature)) {
      return NextResponse.json(
        { error: "that transaction paid for a pair, and is not a trade", recorded: false },
        { status: 409 },
      );
    }

    const cookPriceUsd = await fetchCookPriceUsd();
    const fill =
      b.source === "launchpad"
        ? b.pool
          ? await launchpadFill(proof, b.mint, b.pool, cookPriceUsd)
          : null
        : swapFill(proof, b.wallet, b.mint, cookPriceUsd);

    if (!fill) {
      return NextResponse.json(
        {
          error: "that transaction did not trade this token",
          hint:
            b.source === "launchpad"
              ? "a launchpad fill has to name the pool it traded on, and the launchpad has to agree the pool belongs to this mint"
              : "the wallet's balance of the token has to move on the transaction being reported",
          recorded: false,
        },
        { status: 422 },
      );
    }

    // A pair the token does not carry is dropped rather than refused: the fill still accrues its
    // fee, it just does not count towards any pair's listing fees.
    const ticker =
      b.ticker && (await carriesBenchmark(b.mint, b.ticker)) ? b.ticker.toUpperCase() : null;

    // Both resolved here rather than sent, so a client cannot name whoever it likes as the creator,
    // nor rename somebody else's token on the rewards page.
    const creator = (await tokenCreator(b.mint))?.wallet ?? null;
    const symbol =
      ("symbol" in fill ? fill.symbol : null) || (await registrySymbol(b.mint)) || null;

    const res = await recordFill({
      signature: b.signature,
      wallet: b.wallet,
      source: b.source,
      mint: b.mint,
      ticker,
      symbol,
      side: "side" in fill ? fill.side : b.side,
      valueUsd: fill.valueUsd,
      feeUsd: fill.feeUsd,
      creator: creator ?? undefined,
    });
    return NextResponse.json({
      ...res,
      valueUsd: fill.valueUsd,
      feeUsd: fill.feeUsd,
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
