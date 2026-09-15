/**
 * Who holds a token, at one moment: the snapshot a holder reward is shared out over.
 *
 * Read straight from the chain rather than from anything Coorwa records, because a holder never has
 * to have touched Coorwa to be one. Two places a token can be held:
 *
 *   1. SPL token accounts, under either token program, found with `getProgramAccounts` filtered by
 *      mint. Cookie Chain's RPC serves that filter.
 *   2. Shares on a MomoSwap curve, which the launchpad programme tracks itself rather than as token
 *      accounts. The launchpad's holders endpoint comes back empty, so they are netted from the
 *      pool's trade feed, the same fallback `fetchPosition` uses. Only asked for a token launched
 *      here, and only when no wallet holds it as an SPL token: a curve that has graduated has turned
 *      into token accounts, and counting both would pay a holder twice.
 *
 * Owners that are not wallets are dropped. A pool vault, a curve, a program's escrow: all of them are
 * accounts owned by a program address, which has no private key and is never on the ed25519 curve.
 * Paying one would send the reward somewhere nobody can claim it. Coorwa's own collecting wallets are
 * dropped too, so the operator never shares a pool it funds.
 *
 * Server only.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import {
  COOKIE_RPC_URL,
  COORWA_REFERRER,
  HOLDER_MIN_USD,
  VAULT_AUTHORITY,
} from "./config";
import { db, dbEnabled, schema } from "./db";
import { fetchCookPriceUsd, fetchTokens } from "./cookiescan";
import { fetchPoolTrades } from "./launchpad";
import { uiToRaw } from "./format";

const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

/** Wallets that never share a holder pool, whatever they hold. */
export function excludedOwners(): Set<string> {
  return new Set([COORWA_REFERRER, VAULT_AUTHORITY].filter(Boolean));
}

/** A wallet is an address somebody holds a key to, which a program address never is. */
export function isWallet(address: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

/**
 * The part of a snapshot that must not be wrong, with the chain taken out of it.
 *
 * Sums every account a wallet holds, drops what is not a wallet or is excluded, and applies the USD
 * floor when the token has a price. Weights are the raw balances, so a holder is paid in proportion
 * to what they hold and nothing else.
 */
export function eligibleHolders(args: {
  accounts: readonly { owner: string; amountRaw: bigint }[];
  decimals: number;
  priceUsd: number | null;
  minUsd: number;
  excluded: ReadonlySet<string>;
  isWallet: (address: string) => boolean;
}): Map<string, bigint> {
  const summed = new Map<string, bigint>();
  for (const a of args.accounts) {
    if (a.amountRaw <= 0n) continue;
    summed.set(a.owner, (summed.get(a.owner) ?? 0n) + a.amountRaw);
  }

  const out = new Map<string, bigint>();
  const price = args.priceUsd != null && args.priceUsd > 0 ? args.priceUsd : null;
  for (const [owner, raw] of summed) {
    if (args.excluded.has(owner) || !args.isWallet(owner)) continue;
    if (price != null && (Number(raw) / 10 ** args.decimals) * price < args.minUsd) continue;
    out.set(owner, raw);
  }
  return out;
}

interface ParsedTokenAccount {
  account: {
    data: {
      parsed?: {
        type?: string;
        info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string; decimals?: number } };
      };
    };
  };
}

async function tokenAccounts(connection: Connection, mint: string) {
  const accounts: { owner: string; amountRaw: bigint }[] = [];
  let decimals: number | null = null;

  for (const program of TOKEN_PROGRAMS) {
    const rows = (await connection.getParsedProgramAccounts(new PublicKey(program), {
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
    })) as unknown as ParsedTokenAccount[];

    for (const row of rows) {
      const parsed = row.account.data.parsed;
      const info = parsed?.info;
      // A mint account can match the filter by coincidence of its first bytes. Only accounts count.
      if (parsed?.type !== "account" || info?.mint !== mint || !info.owner) continue;
      const amount = info.tokenAmount?.amount;
      if (!amount) continue;
      decimals ??= info.tokenAmount?.decimals ?? null;
      accounts.push({ owner: info.owner, amountRaw: BigInt(amount) });
    }
  }
  return { accounts, decimals };
}

/** Curve shares netted per trader from the launchpad's trade feed, in raw units. */
async function curveAccounts(pool: string, decimals: number) {
  const net = new Map<string, number>();
  for (const t of await fetchPoolTrades(pool)) {
    net.set(t.trader, (net.get(t.trader) ?? 0) + (t.side === "buy" ? t.tokens : -t.tokens));
  }
  return [...net]
    .filter(([, tokens]) => tokens > 0)
    .map(([owner, tokens]) => ({ owner, amountRaw: BigInt(uiToRaw(tokens, decimals)) }));
}

async function launchPool(mint: string): Promise<string | null> {
  if (!dbEnabled || !db) return null;
  const [row] = await db
    .select({ pool: schema.launches.pool })
    .from(schema.launches)
    .where(eq(schema.launches.mint, mint))
    .limit(1);
  return row?.pool ?? null;
}

async function pricesByMint(): Promise<Map<string, number>> {
  const [tokens, cookUsd] = await Promise.all([fetchTokens(), fetchCookPriceUsd()]);
  const out = new Map<string, number>();
  for (const t of tokens) {
    const direct = t.price?.usd;
    const native = t.price?.native;
    const usd =
      typeof direct === "number" && direct > 0
        ? direct
        : cookUsd && typeof native === "number" && native > 0
          ? native * cookUsd
          : null;
    if (usd) out.set(t.mint, usd);
  }
  return out;
}

export interface HolderSnapshot {
  mint: string;
  holders: Map<string, bigint>;
  source: "token-accounts" | "curve" | "none";
}

/**
 * Snapshot the holders of each mint, one after another so a large set does not hammer the RPC.
 *
 * A mint whose read fails comes back with no holders rather than failing the whole epoch: its pool
 * simply waits for the next one, which is the same thing that happens to a token nobody holds.
 */
export async function snapshotHolders(mints: readonly string[]): Promise<HolderSnapshot[]> {
  const connection = new Connection(COOKIE_RPC_URL, "confirmed");
  const prices = await pricesByMint().catch(() => new Map<string, number>());
  const excluded = excludedOwners();
  const out: HolderSnapshot[] = [];

  for (const mint of mints) {
    try {
      const { accounts, decimals } = await tokenAccounts(connection, mint);
      const common = {
        decimals: decimals ?? 6,
        priceUsd: prices.get(mint) ?? null,
        minUsd: HOLDER_MIN_USD,
        excluded,
        isWallet,
      };

      const held = eligibleHolders({ ...common, accounts });
      if (held.size > 0) {
        out.push({ mint, holders: held, source: "token-accounts" });
        continue;
      }

      const pool = await launchPool(mint);
      if (pool) {
        const onCurve = eligibleHolders({ ...common, accounts: await curveAccounts(pool, common.decimals) });
        if (onCurve.size > 0) {
          out.push({ mint, holders: onCurve, source: "curve" });
          continue;
        }
      }
      out.push({ mint, holders: new Map(), source: "none" });
    } catch {
      out.push({ mint, holders: new Map(), source: "none" });
    }
  }
  return out;
}
