import { NextResponse } from "next/server";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import {
  billableTickers,
  cookToUsd,
  listedFor,
  listingQuote,
  listingsFor,
  pairsPaidFor,
  recordListings,
  signatureSpent,
  FREE_TICKER,
} from "@/lib/listings";
import { proveTransaction, isProven, tokenCredited } from "@/lib/onchain";
import { tokenCreator } from "@/lib/creators";
import { fetchCookPriceUsd } from "@/lib/cookiescan";
import { fundsPda, vaultPda } from "@/lib/vault";
import { COOK_MINT, VAULT_MINT } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Where a listing fee has to land: the cashback vault's own funds account. */
function vaultFunds(): string {
  return fundsPda(vaultPda(new PublicKey(VAULT_MINT))).toBase58();
}

/**
 * What a token already carries, and what more would cost.
 *
 * Quoting is a read, so it needs no wallet. The COOK figure is deliberately a little above the
 * strict price: it is signed now and confirms later, and COOK moves in between.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mint = url.searchParams.get("mint")?.trim();
  if (!mint) return NextResponse.json({ error: "mint is required" }, { status: 400 });

  const wanted = (url.searchParams.get("tickers") ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  try {
    const [listed, cookPriceUsd, history, creator] = await Promise.all([
      listedFor(mint),
      fetchCookPriceUsd(),
      listingsFor(mint),
      tokenCreator(mint),
    ]);
    const billable = billableTickers(wanted, listed);

    return NextResponse.json({
      mint,
      free: FREE_TICKER,
      listed,
      billable,
      // Named so the panel can say whose wallet has to be connected rather than just refusing.
      creator: creator?.wallet ?? null,
      creatorSource: creator?.source ?? null,
      cookPriceUsd,
      fundsAccount: vaultFunds(),
      history,
      ...listingQuote(billable.length, cookPriceUsd),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not price the listing" },
      { status: 502 },
    );
  }
}

const Body = z.object({
  /** The `fund` transaction that paid for this batch. */
  signature: z.string().min(64).max(128),
  mint: z.string().min(32).max(44),
  payer: z.string().min(32).max(44),
  tickers: z.array(z.string().min(1).max(12)).min(1).max(16),
});

/**
 * Turn a payment into listings.
 *
 * Nothing here is taken on the client's word. The transaction is read back from the chain, has to
 * have been signed by the payer, and has to have actually credited the vault's funds account - the
 * amount that landed there is what decides how many pairs it bought, priced at the time it is read
 * rather than at whatever was quoted. One transaction buys one batch: the signature is checked
 * against the table first, so a payment cannot be presented twice.
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
    if (await signatureSpent(b.signature)) {
      return NextResponse.json(
        { error: "that payment has already bought its pairs", recorded: 0 },
        { status: 409 },
      );
    }

    // Only the token's creator may benchmark it. They are the one who earns the creator share of
    // every fee the pair goes on to generate, so letting a stranger choose it would be handing away
    // somebody else's position. Proved against the launch when Coorwa made the token, and against
    // the mint's own metadata authority otherwise.
    const creator = await tokenCreator(b.mint);
    if (!creator) {
      return NextResponse.json(
        {
          error: "this token has no creator Coorwa can verify",
          hint: "its mint names no metadata authority, so there is nobody to prove a claim against",
          recorded: 0,
        },
        { status: 403 },
      );
    }
    if (creator.wallet !== b.payer) {
      return NextResponse.json(
        {
          error: "only this token's creator can add a benchmark to it",
          hint: `connect ${creator.wallet} and try again`,
          recorded: 0,
        },
        { status: 403 },
      );
    }

    const proof = await proveTransaction({ signature: b.signature, wallet: b.payer });
    if (!isProven(proof)) {
      return NextResponse.json({ error: proof.error, recorded: 0 }, { status: proof.status });
    }

    const paidRaw = tokenCredited(proof, vaultFunds(), COOK_MINT);
    if (paidRaw == null || paidRaw <= 0n) {
      return NextResponse.json(
        {
          error: "that transaction did not pay the cashback vault",
          hint: "a listing is bought by funding the vault, which is what the panel builds",
          recorded: 0,
        },
        { status: 403 },
      );
    }

    const cookPriceUsd = await fetchCookPriceUsd();
    if (!cookPriceUsd) {
      return NextResponse.json(
        { error: "no COOK price available, so the payment cannot be valued", recorded: 0 },
        { status: 503 },
      );
    }

    const paidUsd = cookToUsd(paidRaw, cookPriceUsd);
    const listed = await listedFor(b.mint);
    // Billable first, so a payment is never spent on a pair the token already carries.
    const billable = billableTickers(b.tickers, listed);
    const affordable = billable.slice(0, pairsPaidFor(paidUsd));

    const { recorded } = await recordListings({
      mint: b.mint,
      tickers: affordable,
      payer: b.payer,
      signature: b.signature,
      paidRaw,
      paidUsd,
    });

    return NextResponse.json({
      recorded,
      listed: affordable.slice(0, recorded),
      paidUsd,
      asked: billable.length,
      note:
        recorded < billable.length
          ? "the payment covered fewer pairs than were asked for, so the rest were not listed"
          : undefined,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not record the listing", recorded: 0 },
      { status: 502 },
    );
  }
}
