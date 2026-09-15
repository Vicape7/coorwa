/**
 * Tokens launched through Coorwa, and the RWA each creator benchmarked theirs against.
 *
 * A token launched here is a TOKEN/RWA instrument from the start: the creator picks one real-world
 * asset at launch, and that first pair is free and fixed. More can be bought later by anyone
 * (`listings.ts`). A token from anywhere else has no pair until somebody buys one.
 *
 * Like the rest of the database, it is optional. With no DATABASE_URL every read here comes back
 * empty.
 */
import { desc, eq } from "drizzle-orm";
import { db, dbEnabled, schema } from "./db";
import { cached } from "./http";
import { rwaByTicker } from "./rwa";

export interface LaunchRecord {
  mint: string;
  pool: string;
  creator: string;
  ticker: string;
  symbol: string | null;
  name: string | null;
  signature: string;
  createdAt: string;
}

export async function recordLaunch(row: {
  mint: string;
  pool: string;
  creator: string;
  ticker: string;
  symbol?: string | null;
  name?: string | null;
  signature: string;
}): Promise<{ recorded: boolean }> {
  if (!dbEnabled || !db) return { recorded: false };

  await db
    .insert(schema.launches)
    .values({
      mint: row.mint,
      pool: row.pool,
      creator: row.creator,
      ticker: row.ticker.toUpperCase(),
      symbol: row.symbol ?? null,
      name: row.name ?? null,
      signature: row.signature,
    })
    // First write wins. A benchmark that could be overwritten would rewrite the token's whole
    // history, so a second attempt on the same mint is a no-op rather than an update.
    .onConflictDoNothing({ target: schema.launches.mint });

  return { recorded: true };
}

/**
 * Every pinned mint, as mint -> ticker.
 *
 * Read on every universe build, so it is cached briefly. The map is small by construction: it only
 * ever holds tokens launched through Coorwa.
 */
export async function benchmarks(): Promise<Map<string, string>> {
  if (!dbEnabled || !db) return new Map();

  return cached("launches:benchmarks", 30_000, async () => {
    const rows = await db!
      .select({ mint: schema.launches.mint, ticker: schema.launches.ticker })
      .from(schema.launches);

    const out = new Map<string, string>();
    for (const r of rows) {
      // An asset that has since been dropped from RWA_ASSETS cannot be priced, so it is left out.
      if (rwaByTicker(r.ticker)) out.set(r.mint, r.ticker.toUpperCase());
    }
    return out;
  });
}

/** What one wallet has launched here, newest first. Backs the creator's own page. */
export async function launchesByCreator(creator: string): Promise<LaunchRecord[]> {
  if (!dbEnabled || !db) return [];

  const rows = await db
    .select()
    .from(schema.launches)
    .where(eq(schema.launches.creator, creator))
    .orderBy(desc(schema.launches.createdAt))
    .limit(50);

  return rows.map((r) => ({
    mint: r.mint,
    pool: r.pool,
    creator: r.creator,
    ticker: r.ticker,
    symbol: r.symbol,
    name: r.name,
    signature: r.signature,
    createdAt: r.createdAt.toISOString(),
  }));
}
