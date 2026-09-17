/**
 * Token logos for lists that only know a mint, or a mint and its metadata URI.
 *
 * The Cookiescan registry carries a logo for most tokens. A launchpad token can be missing from it
 * for a while after launch, so its metadata JSON is read from IPFS instead, through Filebase, which
 * answered in about 1.6 s where ipfs.io took 28 s to fail (see `token-mark.tsx`).
 *
 * Those reads still fail now and then on a Worker, so every logo found is written to the database
 * and read back first next time. A token whose logo was seen once keeps it, rather than showing it
 * on one request and initials on the next.
 *
 * Server only.
 */
import { inArray, sql } from "drizzle-orm";
import { fetchTokens } from "./cookiescan";
import { db, dbEnabled, schema } from "./db";
import { cached, fetchJson } from "./http";

const METADATA_GATEWAY = "https://ipfs.filebase.io/ipfs/";

function gatewayUrl(uri: string): string | null {
  const ipfs = uri.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/);
  if (ipfs) return METADATA_GATEWAY + ipfs[1];
  return /^https:\/\//.test(uri) ? uri : null;
}

/**
 * The `image` of a token's metadata JSON, cached for a day because a CID never changes. A failed
 * read is not cached, so a gateway timeout on a cold Worker does not hide the logo for a day.
 */
async function imageFromUri(uri: string): Promise<string | null> {
  const url = gatewayUrl(uri);
  if (!url) return null;
  return cached(`token-logo:${uri}`, 24 * 60 * 60 * 1000, async () => {
    const meta = await fetchJson<{ image?: unknown }>(url, { timeoutMs: 8_000 });
    return typeof meta?.image === "string" && meta.image ? meta.image : null;
  }).catch(() => null);
}

/** Logos already found for these mints. Empty without a database, or when the read fails. */
async function storedLogos(mints: readonly string[]): Promise<Map<string, string>> {
  if (!dbEnabled || !db || mints.length === 0) return new Map();
  try {
    const { tokenLogos } = schema;
    const rows = await db
      .select({ mint: tokenLogos.mint, logo: tokenLogos.logo })
      .from(tokenLogos)
      .where(inArray(tokenLogos.mint, [...mints]));
    return new Map(rows.map((r) => [r.mint, r.logo]));
  } catch {
    return new Map();
  }
}

/** Keep what was found. A failed write only costs the next request a fresh read. */
async function storeLogos(found: ReadonlyMap<string, string>): Promise<void> {
  if (!dbEnabled || !db || found.size === 0) return;
  try {
    const { tokenLogos } = schema;
    await db
      .insert(tokenLogos)
      .values([...found].map(([mint, logo]) => ({ mint, logo })))
      .onConflictDoUpdate({
        target: tokenLogos.mint,
        set: { logo: sql`excluded.logo`, updatedAt: sql`now()` },
      });
  } catch {
    // Nothing depends on it landing.
  }
}

/**
 * A logo per mint, or none. Never throws: a missing logo falls back to initials in the UI.
 *
 * The registry wins when it has one, then a logo stored earlier, and only then the token's IPFS
 * metadata. Whatever is new or has changed is stored for next time.
 */
export async function logosByMint(
  tokens: readonly { mint: string; uri?: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (tokens.length === 0) return out;

  const [registry, stored] = await Promise.all([
    fetchTokens().catch(() => []),
    storedLogos([...new Set(tokens.map((t) => t.mint))]),
  ]);
  const fromRegistry = new Map(
    registry.filter((t) => t.metadata?.logo).map((t) => [t.mint, t.metadata!.logo!]),
  );

  await Promise.all(
    tokens.map(async ({ mint, uri }) => {
      const logo =
        fromRegistry.get(mint) ?? stored.get(mint) ?? (uri ? await imageFromUri(uri) : null);
      if (logo) out.set(mint, logo);
    }),
  );

  const changed = new Map([...out].filter(([mint, logo]) => stored.get(mint) !== logo));
  await storeLogos(changed);
  return out;
}
