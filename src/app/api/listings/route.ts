import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cookToUsd,
  listedFor,
  listingQuote,
  listingsFor,
  paymentCovers,
  recordListing,
  signatureSpent,
} from "@/lib/listings";
import { proveTransaction, isProven, lamportsCredited } from "@/lib/onchain";
import { fillRecorded } from "@/lib/rewards";
import { tokenCreator } from "@/lib/creators";
import { fetchCookPriceUsd, fetchMarkets, liquidityByMint } from "@/lib/cookiescan";
import { benchmarks } from "@/lib/launches";
import { rwaByTicker } from "@/lib/rwa";
import { ADDRESS_RE, COORWA_OPERATOR } from "@/lib/config";

export const dynamic = "force-dynamic";

/** The same floor `buildUniverse` applies, so a pair that is paid for actually appears. */
const MIN_LIQUIDITY_USD = 1;

/**
 * A token's pair, who may set it, and what setting it costs.
 *
 * Quoting is a read, so it needs no wallet. The COOK figure is deliberately a little above the
 * strict price: it is signed now and confirms later, and COOK moves in between.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mint = url.searchParams.get("mint")?.trim();
  if (!mint) return NextResponse.json({ error: "mint is required" }, { status: 400 });

  try {
    const [pin, listed, cookPriceUsd, history, creator, markets] = await Promise.all([
      benchmarks().then((b) => b.get(mint) ?? null),
      listedFor(mint),
      fetchCookPriceUsd(),
      listingsFor(mint),
      tokenCreator(mint),
      fetchMarkets(),
    ]);
    const liquidityUsd = liquidityByMint(markets).get(mint) ?? 0;

    return NextResponse.json({
      mint,
      /** The benchmark picked at launch, when the token was launched here. */
      pin,
      /** The token's one pair, however it was set. Null means it can still be set. */
      pair: pin ?? listed,
      liquidityUsd,
      tradeable: liquidityUsd >= MIN_LIQUIDITY_USD,
      /** The only wallet that may set the pair. */
      creator: creator?.wallet ?? null,
      creatorSource: creator?.source ?? null,
      operator: COORWA_OPERATOR || null,
      cookPriceUsd,
      history,
      ...listingQuote(cookPriceUsd),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not price the pair" },
      { status: 502 },
    );
  }
}

const Body = z.object({
  /** The transfer to the operator that paid for the pair. */
  signature: z.string().min(64).max(128),
  mint: z.string().regex(ADDRESS_RE, "not an address"),
  payer: z.string().regex(ADDRESS_RE, "not an address"),
  ticker: z.string().min(1).max(12),
});

/**
 * Turn a payment into the token's pair.
 *
 * Nothing here is taken on the client's word. The payer has to be the token's creator, the token
 * must not have a pair yet and must already trade in a pool, and the transaction is read back from the chain: signed by the payer,
 * and actually crediting the operator with enough COOK, priced when it is read. One transaction
 * sets one pair, so a payment cannot be presented twice, and a trade already counted as a fill
 * cannot be presented as a payment.
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
  const asset = rwaByTicker(b.ticker);
  if (!asset) return NextResponse.json({ error: "unknown asset" }, { status: 400 });
  if (!COORWA_OPERATOR) {
    return NextResponse.json({ error: "no operator is configured here" }, { status: 503 });
  }

  try {
    const creator = await tokenCreator(b.mint);
    if (!creator || creator.wallet !== b.payer) {
      return NextResponse.json(
        { error: "only the token's creator can set its pair" },
        { status: 403 },
      );
    }
    const [pin, listed] = await Promise.all([
      benchmarks().then((m) => m.get(b.mint) ?? null),
      listedFor(b.mint),
    ]);
    if (pin ?? listed) {
      return NextResponse.json(
        { error: `this token is already paired with ${pin ?? listed}` },
        { status: 409 },
      );
    }
    // The form already refuses these before anyone pays. This is for a call that skips the form. The
    // payment is only marked used once a pair is recorded, so it can be sent again after graduation,
    // which is why this is 425 (too early) and not 409: the form keeps the payment to report again.
    const liquidityUsd = liquidityByMint(await fetchMarkets()).get(b.mint) ?? 0;
    if (liquidityUsd < MIN_LIQUIDITY_USD) {
      return NextResponse.json(
        {
          error:
            "this token has no pool on Cookie Chain with real liquidity yet; send the same payment again once it has one",
        },
        { status: 425 },
      );
    }
    if (await signatureSpent(b.signature)) {
      return NextResponse.json({ error: "that payment has already been used" }, { status: 409 });
    }
    // A swap through the terminal also pays the operator in COOK, and its fee is already in the
    // ledger as that token's income. Taking it as a pair payment too would count one dollar twice.
    if (await fillRecorded(b.signature)) {
      return NextResponse.json(
        { error: "that transaction was a trade, and its fee is already counted for its token" },
        { status: 409 },
      );
    }

    const proof = await proveTransaction({ signature: b.signature, wallet: b.payer });
    if (!isProven(proof)) {
      return NextResponse.json({ error: proof.error }, { status: proof.status });
    }

    const paidRaw = lamportsCredited(proof, COORWA_OPERATOR);
    if (paidRaw == null || paidRaw <= 0n) {
      return NextResponse.json(
        { error: "that transaction did not pay the operator" },
        { status: 403 },
      );
    }

    const cookPriceUsd = await fetchCookPriceUsd();
    if (!cookPriceUsd) {
      return NextResponse.json(
        { error: "no COOK price available, so the payment cannot be valued" },
        { status: 503 },
      );
    }

    const paidUsd = cookToUsd(paidRaw, cookPriceUsd);
    if (!paymentCovers(paidUsd)) {
      return NextResponse.json(
        { error: `the payment was worth $${paidUsd.toFixed(2)}, less than the pair costs` },
        { status: 402 },
      );
    }

    const recorded = await recordListing({
      mint: b.mint,
      ticker: asset.ticker,
      payer: b.payer,
      signature: b.signature,
      paidRaw,
      paidUsd,
    });
    // The database refused the row, so something got there first: a pair for this token, or this
    // same payment. Said plainly rather than reported as a success that wrote nothing.
    if (!recorded) {
      return NextResponse.json(
        { error: "this token already has a pair, or that payment has already been used" },
        { status: 409 },
      );
    }

    return NextResponse.json({ recorded, pair: asset.ticker, paidUsd });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not record the pair" },
      { status: 502 },
    );
  }
}
