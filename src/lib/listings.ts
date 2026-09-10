/**
 * Paid benchmarks: extra RWA pairs bought for a token that was not launched through Corwa.
 *
 * The terminal used to be every token crossed with every asset, which is sixteen rows per token and
 * mostly noise. A token now carries one benchmark for nothing, and anything past that is bought at
 * `PAIR_LISTING_USD` a pair. The fee is the filter: a dollar is nothing to somebody who means it,
 * and enough that nobody lists sixteen dead pairs for the sake of it.
 *
 * The money never touches Corwa. It is paid by calling `fund` on the cashback vault, which the
 * program lets anyone call, so it lands in the same account the rebate is paid out of. That is what
 * makes this a listing fee rather than a toll: it goes back to the people trading.
 *
 * Optional like the rest of the database. With no DATABASE_URL nothing is listed, nothing can be
 * bought, and every token falls back to its one free benchmark.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { db, dbEnabled, schema } from "./db";
import { cached } from "./http";
import { COOK_DECIMALS, PAIR_LISTING_USD } from "./config";
import { rwaByTicker, DEFAULT_RWA } from "./rwa";
import { rawToUi } from "./format";

export interface Listing {
  mint: string;
  ticker: string;
  payer: string;
  signature: string;
  paidUsd: number;
  createdAt: string;
}

/**
 * The benchmark every token has without paying anything.
 *
 * Charging for the first one would leave a token invisible until somebody spent money on it, which
 * would empty the terminal rather than tidy it.
 */
export const FREE_TICKER = DEFAULT_RWA.ticker;

/** Which of these are worth paying for: the free one is already there, and so is anything listed. */
export function billableTickers(
  wanted: readonly string[],
  alreadyListed: readonly string[],
): string[] {
  const have = new Set<string>([FREE_TICKER, ...alreadyListed]);
  const out: string[] = [];
  for (const raw of wanted) {
    const asset = rwaByTicker(raw);
    if (!asset || have.has(asset.ticker)) continue;
    have.add(asset.ticker);
    out.push(asset.ticker);
  }
  return out;
}

/**
 * How many pairs a payment actually bought.
 *
 * Priced at what reached the vault rather than at what was quoted, because COOK moves between the
 * two and a quote is not a promise. The grace is there so a payment that was correct when it was
 * signed does not come up one cent short by the time it confirms.
 */
export function pairsPaidFor(paidUsd: number): number {
  if (!(paidUsd > 0)) return 0;
  return Math.floor(paidUsd / PAIR_LISTING_USD + 0.02);
}

/** What to charge for a set of pairs, in COOK at the price given. */
export function listingQuote(pairs: number, cookPriceUsd: number | null) {
  const usd = pairs * PAIR_LISTING_USD;
  // A little over the line, for the same reason `pairsPaidFor` forgives a little under it.
  const cook = cookPriceUsd && cookPriceUsd > 0 ? (usd * 1.02) / cookPriceUsd : null;
  return { pairs, usd, cook, pricePerPairUsd: PAIR_LISTING_USD };
}

export async function listedFor(mint: string): Promise<string[]> {
  if (!dbEnabled || !db) return [];
  const rows = await db
    .select({ ticker: schema.listings.ticker })
    .from(schema.listings)
    .where(eq(schema.listings.mint, mint));
  return rows.map((r) => r.ticker);
}

/**
 * Every paid benchmark, as mint -> tickers.
 *
 * Read on every universe build, so it is cached briefly. Small by construction: it only holds pairs
 * somebody paid for.
 */
export async function listedByMint(): Promise<Map<string, string[]>> {
  if (!dbEnabled || !db) return new Map();

  return cached("listings:byMint", 30_000, async () => {
    const rows = await db!
      .select({ mint: schema.listings.mint, ticker: schema.listings.ticker })
      .from(schema.listings);

    const out = new Map<string, string[]>();
    for (const r of rows) {
      // An asset dropped from RWA_ASSETS since it was bought cannot be priced, so it is left out
      // rather than pinning the token to something the app can no longer quote.
      if (!rwaByTicker(r.ticker)) continue;
      const list = out.get(r.mint);
      if (list) list.push(r.ticker);
      else out.set(r.mint, [r.ticker]);
    }
    return out;
  });
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

export async function recordListings(args: {
  mint: string;
  tickers: string[];
  payer: string;
  signature: string;
  paidRaw: bigint;
  paidUsd: number;
}): Promise<{ recorded: number }> {
  if (!dbEnabled || !db || args.tickers.length === 0) return { recorded: 0 };

  const rows = await db
    .insert(schema.listings)
    .values(
      args.tickers.map((ticker) => ({
        mint: args.mint,
        ticker,
        payer: args.payer,
        signature: args.signature,
        paidRaw: args.paidRaw,
        paidUsd: args.paidUsd,
      })),
    )
    // Somebody else may have bought the same pair in the meantime. Their row stands and this one is
    // dropped, which the caller reports back rather than hiding.
    .onConflictDoNothing({ target: [schema.listings.mint, schema.listings.ticker] })
    .returning({ ticker: schema.listings.ticker });

  return { recorded: rows.length };
}

/** Everything bought for one token, newest first. Backs the receipt on the listing panel. */
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

/** What a set of mints has listed, for a panel showing several tokens at once. */
export async function listedForMany(mints: string[]): Promise<Map<string, string[]>> {
  if (!dbEnabled || !db || mints.length === 0) return new Map();

  const rows = await db
    .select({ mint: schema.listings.mint, ticker: schema.listings.ticker })
    .from(schema.listings)
    .where(inArray(schema.listings.mint, mints));

  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.mint);
    if (list) list.push(r.ticker);
    else out.set(r.mint, [r.ticker]);
  }
  return out;
}

/** Raw COOK as a USD figure, for pricing what actually reached the vault. */
export function cookToUsd(raw: bigint, cookPriceUsd: number): number {
  return rawToUi(raw, COOK_DECIMALS) * cookPriceUsd;
}
