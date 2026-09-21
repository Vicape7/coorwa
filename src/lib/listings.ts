/**
 * The pairs two tokens bought before pairing a token from outside was closed.
 *
 * A pair is the asset a token's holders are paid in, so a token has exactly one. A token launched
 * here picks it at launch (`launches.ts`). A token from anywhere else could once be paired by its
 * creator for a dollar; that is gone, and only a token launched through Coorwa gets a pair now. The
 * two pairs already paid for are read here and stay as they are, because holders bought those
 * tokens expecting to be paid in those assets.
 */
import { eq } from "drizzle-orm";
import { db, dbEnabled, schema } from "./db";
import { cached } from "./http";
import { rwaByTicker } from "./rwa";
import { benchmarks } from "./launches";

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
