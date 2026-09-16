/**
 * What the rewards page shows: a wallet's payouts, and every token's pool.
 *
 * The money is real and already exists: MomoSwap pays a referrer 20% of its 1% curve fee, a swap
 * through Coorwa pays its own 1%, and a pair payment pays a dollar. All of it reaches the operator
 * wallet and is paid out once a day in each token's pair asset (`rewards-ledger.ts`,
 * `payout-cycle.ts`). Every fill read here was written only after its transaction confirmed on-chain,
 * and every payout carries the Solana transaction that sent it.
 */
import { gte, sql } from "drizzle-orm";
import { dbEnabled, db, schema } from "./db";
import { feeShareSql } from "./epochs";
import { COORWA_OPERATOR, MOMOSWAP_TRADE_FEE_BPS, MOMOSWAP_REFERRAL_SHARE } from "./config";
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
   * Tokens this wallet created that have earned fees. The creator's share is paid by the same daily
   * run, in the token's pair asset, so there is nothing to claim; this is where a creator sees it.
   */
  created: RewardPool[];
  pools: RewardPool[];
  runs: RunRow[];
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
  runs: [],
});

/** The fee Coorwa earns on a launchpad fill of this size, in the same units as `valueUsd`. */
export function launchpadReferralFee(valueUsd: number): number {
  return valueUsd * (MOMOSWAP_TRADE_FEE_BPS / 10_000) * MOMOSWAP_REFERRAL_SHARE;
}

export async function summarise(wallet: string | null): Promise<CashbackSummary> {
  if (!dbEnabled || !db) return EMPTY(wallet);

  const [pools, runs, next] = await Promise.all([rewardPools(), recentRuns(), nextRunDueAt()]);
  const base = {
    ...EMPTY(wallet),
    configured: true,
    nextRunAt: next?.toISOString() ?? null,
    pools: pools.slice(0, 50),
    runs,
  };
  if (!wallet) return base;

  const [mine, estimates] = await Promise.all([walletRewards(wallet), holderEstimates(wallet)]);
  const created = pools.filter((p) => p.creator === wallet);
  return { ...base, pending: mine.pending, paid: mine.paid, estimates, created };
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

/** Protocol-wide totals for the marketing surface. */
export async function protocolTotals() {
  if (!dbEnabled || !db) {
    return { configured: false, volumeUsd: 0, feesUsd: 0, rebatedUsd: 0, wallets: 0, fills: 0 };
  }
  const { fills } = schema;
  const [row] = await db
    .select({
      volumeUsd: sql<number>`coalesce(sum(${fills.valueUsd}), 0)`,
      feesUsd: sql<number>`coalesce(sum(${fills.feeUsd}), 0)`,
      rebatedUsd: sql<number>`${feeShareSql("holders")} + ${feeShareSql("creator")}`,
      wallets: sql<number>`count(distinct ${fills.wallet})`,
      fills: sql<number>`count(*)`,
    })
    .from(fills)
    .where(gte(fills.createdAt, new Date(0)));

  const feesUsd = Number(row?.feesUsd ?? 0);
  return {
    configured: true,
    volumeUsd: Number(row?.volumeUsd ?? 0),
    feesUsd,
    rebatedUsd: Number(row?.rebatedUsd ?? 0),
    wallets: Number(row?.wallets ?? 0),
    fills: Number(row?.fills ?? 0),
  };
}
