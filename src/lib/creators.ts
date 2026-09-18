/**
 * Who created a token.
 *
 * A token's creator is paid a share of every fee earned on it, and is the only wallet that may set
 * its pair, so this cannot be a guess: a wrong answer pays a stranger.
 *
 * There are two sources and they are checked in that order:
 *
 * 1. `launches`, for tokens launched through Coorwa. The launch transaction was read back from the
 *    chain before that row was written, so it is as good as an on-chain fact.
 * 2. The mint's metadata update authority, from the Cookie Chain registry, for everything else.
 *
 * The second is worth being careful about. Across the whole registry it is not much use: 4,449 of
 * the 5,088 tokens carrying one point at a single shared launchpad key, so whoever holds that key
 * would count as the creator of thousands of tokens. Across the tokens that actually have liquidity
 * and appear in Coorwa, none of them do - every one resolves to its own wallet. So the shared key is
 * refused by name and the rest are trusted, which is right for the set this is asked about.
 */
import { fetchTokens } from "./cookiescan";
import { cached } from "./http";
import { db, dbEnabled, schema } from "./db";
import { eq } from "drizzle-orm";

/**
 * A launchpad's own metadata authority, shared by thousands of tokens.
 *
 * Anyone holding it would otherwise be the "creator" of every token that launchpad ever made, which
 * is not what a creator is. None of the tokens with real liquidity use it.
 */
const SHARED_AUTHORITIES = new Set(["7hmajuVWXD9iQv8LooaSraSJ6CryJv4WJXKU8gd5H6e"]);

async function updateAuthorities(): Promise<Map<string, string>> {
  return cached("creators:updateAuthority", 60_000, async () => {
    const out = new Map<string, string>();
    for (const t of await fetchTokens()) {
      const authority = t.metadata?.updateAuthority;
      if (authority && !SHARED_AUTHORITIES.has(authority)) out.set(t.mint, authority);
    }
    return out;
  });
}

export interface Creator {
  wallet: string;
  /** "launch" is proved against the chain; "authority" is the registry's metadata authority. */
  source: "launch" | "authority";
}

export async function tokenCreator(mint: string): Promise<Creator | null> {
  if (dbEnabled && db) {
    const [row] = await db
      .select({ creator: schema.launches.creator })
      .from(schema.launches)
      .where(eq(schema.launches.mint, mint))
      .limit(1);
    if (row) return { wallet: row.creator, source: "launch" };
  }

  const authority = (await updateAuthorities()).get(mint);
  return authority ? { wallet: authority, source: "authority" } : null;
}

/** Every token this wallet created, by either source. */
export async function createdBy(wallet: string): Promise<string[]> {
  const mints = new Set<string>();
  if (dbEnabled && db) {
    const rows = await db
      .select({ mint: schema.launches.mint })
      .from(schema.launches)
      .where(eq(schema.launches.creator, wallet));
    for (const r of rows) mints.add(r.mint);
  }
  for (const [mint, authority] of await updateAuthorities()) {
    if (authority === wallet) mints.add(mint);
  }
  return [...mints];
}

/** Whether a wallet is the one paid the creator's share of a token's fees. */
export async function isCreator(mint: string, wallet: string): Promise<boolean> {
  const creator = await tokenCreator(mint);
  return creator?.wallet === wallet;
}
