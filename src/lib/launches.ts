/**
 * Tokens launched through Coorwa, and the RWA each creator benchmarked theirs against.
 *
 * A token launched here is a TOKEN/RWA instrument from the start: the creator picks one real-world
 * asset at launch, free, and it is the token's only pair for good. A token from anywhere else has no
 * pair until its creator pays for one (`listings.ts`).
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
}): Promise<{ recorded: boolean; existing?: string }> {
  if (!dbEnabled || !db) return { recorded: false };

  const rows = await db
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
    .onConflictDoNothing({ target: schema.launches.mint })
    .returning({ mint: schema.launches.mint });

  if (rows.length > 0) return { recorded: true };

  // Nothing written means the mint already had its launch recorded, and that one stands. Its pair
  // is returned so a repeated report of the same launch can be told apart from a different pick.
  const [first] = await db
    .select({ ticker: schema.launches.ticker })
    .from(schema.launches)
    .where(eq(schema.launches.mint, row.mint))
    .limit(1);
  return { recorded: false, existing: first?.ticker };
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
