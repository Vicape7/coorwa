/**
 * Token logos for lists that only know a mint, or a mint and its metadata URI.
 *
 * The Cookiescan registry carries a logo for most tokens. A launchpad token can be missing from it
 * for a while after launch, so its metadata JSON is read from IPFS instead, through Filebase, which
 * answered in about 1.6 s where ipfs.io took 28 s to fail (see `token-mark.tsx`).
 *
 * Server only.
 */
import { fetchTokens } from "./cookiescan";
import { cached, fetchJson } from "./http";

const METADATA_GATEWAY = "https://ipfs.filebase.io/ipfs/";

function gatewayUrl(uri: string): string | null {
  const ipfs = uri.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/);
  if (ipfs) return METADATA_GATEWAY + ipfs[1];
  return /^https:\/\//.test(uri) ? uri : null;
}

/** The `image` of a token's metadata JSON, cached for a day because a CID never changes. */
async function imageFromUri(uri: string): Promise<string | null> {
  const url = gatewayUrl(uri);
  if (!url) return null;
  return cached(`token-logo:${uri}`, 24 * 60 * 60 * 1000, async () => {
    const meta = await fetchJson<{ image?: unknown }>(url, { timeoutMs: 6_000 }).catch(() => null);
    return typeof meta?.image === "string" && meta.image ? meta.image : null;
  });
}

/** A logo per mint, or none. Never throws: a missing logo falls back to initials in the UI. */
export async function logosByMint(
  tokens: readonly { mint: string; uri?: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (tokens.length === 0) return out;

  const registry = await fetchTokens().catch(() => []);
  const fromRegistry = new Map(
    registry.filter((t) => t.metadata?.logo).map((t) => [t.mint, t.metadata!.logo!]),
  );

  await Promise.all(
    tokens.map(async ({ mint, uri }) => {
      const logo = fromRegistry.get(mint) ?? (uri ? await imageFromUri(uri) : null);
      if (logo) out.set(mint, logo);
    }),
  );
  return out;
}
