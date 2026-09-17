/**
 * A token's one pair, for tokens that were not launched through Coorwa.
 *
 * A pair is the asset a token's holders are paid in, so a token has exactly one and it belongs to the
 * token's creator to choose. A token launched here gets it at launch (`launches.ts`). Any other token
 * has none, and is not in the terminal, until its creator pays `PAIR_LISTING_USD` once and picks it.
 * Nobody else can set it and it cannot be changed, because holders buy a token expecting to be paid
 * in that asset.
 *
 * The payment is a plain COOK transfer to the operator, and the dollar joins the token's holder
 * rewards. Optional like the rest of the database: with no DATABASE_URL nothing can be listed.
 */
import { desc, eq } from "drizzle-orm";
import { db, dbEnabled, schema } from "./db";
import { cached } from "./http";
import { COOK_DECIMALS, PAIR_LISTING_USD } from "./config";
import { rwaByTicker } from "./rwa";
import { rawToUi } from "./format";
import { benchmarks } from "./launches";

export interface Listing {
  mint: string;
  ticker: string;
  payer: string;
  signature: string;
  paidUsd: number;
  createdAt: string;
}

/**
 * Whether a payment covers the pair.
 *
 * Priced at what reached the operator rather than at what was quoted, because COOK moves between the
 * two and a quote is not a promise. The grace is there so a payment that was correct when it was
 * signed does not come up one cent short by the time it confirms.
 */
export function paymentCovers(paidUsd: number): boolean {
  return paidUsd > 0 && paidUsd / PAIR_LISTING_USD + 0.02 >= 1;
}

/** What to charge for the pair, in COOK at the price given. */
export function listingQuote(cookPriceUsd: number | null) {
  const usd = PAIR_LISTING_USD;
  // A little over the line, for the same reason `paymentCovers` forgives a little under it.
  const cook = cookPriceUsd && cookPriceUsd > 0 ? (usd * 1.02) / cookPriceUsd : null;
  return { usd, cook };
}

/** The pair bought for a token, if one was. The oldest row wins, from before one pair was the rule. */
export async function listedFor(mint: string): Promise<string | null> {
  if (!dbEnabled || !db) return null;
  const [row] = await db
    .select({ ticker: schema.listings.ticker })
    .from(schema.listings)
    .where(eq(schema.listings.mint, mint))
    .orderBy(schema.listings.createdAt)
    .limit(1);
  return row?.ticker ?? null;
}

/**
 * Every bought pair, as mint -> ticker.
 *
 * Read on every universe build, so it is cached briefly. Small by construction: it only holds pairs
 * somebody paid for.
 */
export async function listedByMint(): Promise<Map<string, string>> {
  if (!dbEnabled || !db) return new Map();

  return cached("listings:byMint", 30_000, async () => {
    const rows = await db!
      .select({ mint: schema.listings.mint, ticker: schema.listings.ticker })
      .from(schema.listings)
      .orderBy(schema.listings.createdAt);

    const out = new Map<string, string>();
    for (const r of rows) {
      // An asset dropped from RWA_ASSETS since it was bought cannot be priced, so it is left out
      // rather than pinning the token to something the app can no longer quote.
      if (!rwaByTicker(r.ticker) || out.has(r.mint)) continue;
      out.set(r.mint, r.ticker);
    }
    return out;
  });
}

/** A token's pair: the one picked at launch, or else the one its creator bought. */
export async function pairFor(mint: string): Promise<string | null> {
  const [pin, listed] = await Promise.all([benchmarks().then((b) => b.get(mint)), listedFor(mint)]);
  return pin ?? listed;
}

/** Does this token's pair use this asset? Asked before a fill is attributed to a pair. */
export async function carriesBenchmark(mint: string, ticker: string): Promise<boolean> {
  const asset = rwaByTicker(ticker);
  return asset != null && (await pairFor(mint)) === asset.ticker;
}

/** Has this payment already been spent on listings? One transaction buys one batch. */
export async function signatureSpent(signature: string): Promise<boolean> {
  if (!dbEnabled || !db) return false;
  const [row] = await db
    .select({ id: schema.listings.id })
    .from(schema.listings)
    .where(eq(schema.listings.signature, signature))
    .limit(1);
  return row != null;
}

export async function recordListing(args: {
  mint: string;
  ticker: string;
  payer: string;
  signature: string;
  paidRaw: bigint;
  paidUsd: number;
}): Promise<boolean> {
  if (!dbEnabled || !db) return false;

  // Any conflict means this pair is already bought: the same pair twice, a second pair for a token
  // that has one, or the same payment presented again. All three are no-ops rather than errors,
  // and the database is what settles them, because two requests can pass the route's checks at once.
  const rows = await db
    .insert(schema.listings)
    .values(args)
    .onConflictDoNothing()
    .returning({ ticker: schema.listings.ticker });

  return rows.length > 0;
}

/** Every payment recorded for one token, newest first. Backs the receipt on the listing panel. */
export async function listingsFor(mint: string): Promise<Listing[]> {
  if (!dbEnabled || !db) return [];

  const rows = await db
    .select()
    .from(schema.listings)
    .where(eq(schema.listings.mint, mint))
    .orderBy(desc(schema.listings.createdAt))
    .limit(50);

  return rows.map((r) => ({
    mint: r.mint,
    ticker: r.ticker,
    payer: r.payer,
    signature: r.signature,
    paidUsd: r.paidUsd,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Raw COOK as a USD figure, for pricing what actually reached the operator. */
export function cookToUsd(raw: bigint, cookPriceUsd: number): number {
  return rawToUi(raw, COOK_DECIMALS) * cookPriceUsd;
}
