/**
 * What the rewards page shows: a wallet's payouts, and every token's pool.
 *
 * The money is real and already exists: MomoSwap pays a referrer 20% of its 1% curve fee, a swap
 * through Coorwa pays its own 1%, and a pair payment pays a dollar. All of it reaches the operator
 * wallet and is paid out once a day in each token's pair asset (`rewards-ledger.ts`,
 * `payout-cycle.ts`). Every fill read here was written only after its transaction confirmed on-chain,
 * and every payout carries the Solana transaction that sent it.
 */
import { dbEnabled, db, schema } from "./db";
import { fetchTokens } from "./cookiescan";
import { createdBy } from "./creators";
import { logosByMint } from "./token-logos";
import { benchmarks } from "./launches";
import { listedByMint } from "./listings";
import { COORWA_OPERATOR } from "./config";
import {
  holderEstimates,
  nextRunDueAt,
  recentRuns,
  rewardPools,
  walletRewards,
  type HolderEstimate,
  type RewardPool,
  type RunRow,
  type WalletRewards,
} from "./rewards-ledger";

export interface CashbackSummary {
  configured: boolean;
  wallet: string | null;
  /** The address every fee is paid to and every payout is sent from. */
  operator: string | null;
  /** When the next daily run is due, or null while nothing is waiting. */
  nextRunAt: string | null;
  /** Owed to this wallet but under the minimum, per asset. Paid once it adds up. */
  pending: WalletRewards["pending"];
  /** Sent to this wallet, newest first. */
  paid: WalletRewards["paid"];
  /** This wallet's estimated share of what is waiting, from the holder samples so far. */
  estimates: HolderEstimate[];
  /**
   * Every token this wallet created, with or without fees yet. The creator's share is paid by the
   * same daily run, in the token's pair asset, so there is nothing to claim; this is where a creator
   * sees it. Empty for a wallet that never created a token.
   */
  created: RewardPool[];
  pools: RewardPool[];
  /** A logo per mint for every token named above, where one is known. */
  logos: Record<string, string>;
  runs: RunRow[];
  /** Across every token, for the landing page. */
  totals: RewardTotals;
}

export interface RewardTotals {
  /** Sent to holders and creators. */
  paidUsd: number;
  /** Earned by holders and creators and not sent yet. */
  waitingUsd: number;
  /** Tokens with a pair, launched here or listed. */
  tokensPaired: number;
}

const EMPTY = (wallet: string | null): CashbackSummary => ({
  configured: false,
  wallet,
  operator: COORWA_OPERATOR || null,
  nextRunAt: null,
  pending: [],
  paid: [],
  estimates: [],
  created: [],
  pools: [],
  logos: {},
  runs: [],
  totals: { paidUsd: 0, waitingUsd: 0, tokensPaired: 0 },
});

export async function summarise(wallet: string | null): Promise<CashbackSummary> {
  if (!dbEnabled || !db) return EMPTY(wallet);

  const [pools, runs, next, pinned, listed] = await Promise.all([
    rewardPools(),
    recentRuns(),
    nextRunDueAt(),
    benchmarks(),
    listedByMint(),
  ]);
  const base = {
    ...EMPTY(wallet),
    configured: true,
    nextRunAt: next?.toISOString() ?? null,
    pools: pools.slice(0, 50),
    runs,
    totals: rewardTotals(pools, new Set([...pinned.keys(), ...listed.keys()]).size),
  };
  if (!wallet) return { ...base, logos: await logosFor(base.pools) };

  const [mine, estimates, made, tokens] = await Promise.all([
    walletRewards(wallet),
    holderEstimates(wallet),
    createdBy(wallet).catch(() => [] as string[]),
    fetchTokens().catch(() => []),
  ]);
  const poolOf = new Map(pools.map((p) => [p.mint, p]));
  const mints = new Set([...made, ...pools.filter((p) => p.creator === wallet).map((p) => p.mint)]);
  const symbolOf = new Map(tokens.map((t) => [t.mint, t.metadata?.symbol?.trim() || null]));
  const created = [...mints]
    .map((mint) => poolOf.get(mint) ?? emptyPool(mint, pinned.get(mint) ?? listed.get(mint) ?? null))
    .map((p) => ({ ...p, symbol: p.symbol ?? symbolOf.get(p.mint) ?? null }))
    .sort((a, b) => b.creatorAccruedUsd - a.creatorAccruedUsd);
  const logos = await logosFor([...base.pools, ...created, ...estimates, ...mine.paid]);
  return { ...base, pending: mine.pending, paid: mine.paid, estimates, created, logos };
}

async function logosFor(tokens: readonly { mint: string }[]): Promise<Record<string, string>> {
  const mints = [...new Set(tokens.map((t) => t.mint))];
  return Object.fromEntries(await logosByMint(mints.map((mint) => ({ mint }))));
}

/** A token with no fees yet, so a creator still sees it listed. */
function emptyPool(mint: string, ticker: string | null): RewardPool {
  return {
    mint,
    symbol: null,
    ticker,
    holdersAccruedUsd: 0,
    holdersAllocatedUsd: 0,
    holdersWaitingUsd: 0,
    holdersPaidUsd: 0,
    creator: null,
    creatorAccruedUsd: 0,
    creatorAllocatedUsd: 0,
    creatorPaidUsd: 0,
  };
}

export function rewardTotals(pools: readonly RewardPool[], tokensPaired: number): RewardTotals {
  let paidUsd = 0;
  let earnedUsd = 0;
  for (const p of pools) {
    paidUsd += p.holdersPaidUsd + p.creatorPaidUsd;
    earnedUsd += p.holdersAccruedUsd + p.creatorAccruedUsd;
  }
  return { paidUsd, waitingUsd: Math.max(0, earnedUsd - paidUsd), tokensPaired };
}

/** One token's pool, for its pair page. */
export async function tokenRewards(mint: string) {
  if (!dbEnabled || !db) return { configured: false, pool: null, nextRunAt: null };
  const [pools, next] = await Promise.all([rewardPools(), nextRunDueAt()]);
  return {
    configured: true,
    pool: pools.find((p) => p.mint === mint) ?? null,
    nextRunAt: next?.toISOString() ?? null,
  };
}

export interface RecordFill {
  signature: string;
  wallet: string;
  source: "swap" | "launchpad";
  mint: string;
  ticker?: string | null;
  symbol?: string | null;
  side: string;
  valueUsd: number;
  feeUsd: number;
  creator?: string | null;
  chain?: "cookie" | "solana";
}

/**
 * Record a confirmed fill. Idempotent on the signature, so a client that reports twice - a retry,
 * a refresh - cannot inflate its own balance.
 */
export async function recordFill(fill: RecordFill): Promise<{ recorded: boolean }> {
  if (!dbEnabled || !db) return { recorded: false };

  await db
    .insert(schema.fills)
    .values({
      signature: fill.signature,
      wallet: fill.wallet,
      source: fill.source,
      mint: fill.mint,
      ticker: fill.ticker ?? null,
      symbol: fill.symbol ?? null,
      side: fill.side,
      valueUsd: fill.valueUsd,
      feeUsd: fill.feeUsd,
      creator: fill.creator ?? null,
      chain: fill.chain ?? "cookie",
    })
    .onConflictDoNothing({ target: schema.fills.signature });

  return { recorded: true };
}
