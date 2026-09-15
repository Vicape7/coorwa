/**
 * Reward accounting for the rewards page.
 *
 * The money is real and already exists: MomoSwap pays a referrer 20% of its 1% curve fee, a swap
 * through Coorwa pays its own 0.10%, and a pair listing pays a dollar. None of it is kept.
 *
 * Every fee is split per `CASHBACK_SPLIT`: the holders' part joins that token's holder pool, which
 * each epoch shares out over whoever holds the token at its snapshot, and the creator's part goes to
 * whoever made the token. Every row read here was written only after a transaction confirmed
 * on-chain, so a balance is checkable against the explorer rather than taken on trust.
 */
import { and, eq, sql, desc, gte } from "drizzle-orm";
import { db, dbEnabled, schema } from "./db";
import { MOMOSWAP_TRADE_FEE_BPS, MOMOSWAP_REFERRAL_SHARE } from "./config";
import {
  feeShareSql,
  holderEstimates,
  holderPools,
  type HolderEstimate,
  type HolderPool,
} from "./epochs";

export interface CashbackSummary {
  configured: boolean;
  wallet: string | null;
  /** Given to this wallet out of holder pools by published epochs. */
  holderEarnedUsd: number;
  /** The creator's share of every fee earned on tokens this wallet launched. */
  creatorAccruedUsd: number;
  /** Already claimed out of the vault, against a published root. */
  paidUsd: number;
  /**
   * Sitting in a published epoch: either claimed already, or waiting for its claimant inside the
   * window. Committed money cannot appear in a later epoch, which is what stops a double payout.
   */
  committedUsd: number;
  /**
   * Owed and not yet in any open epoch: the creator share so far, and anything from an epoch that
   * expired unclaimed. A holder's share of a pool is not in here until a snapshot has been taken,
   * because until then nobody knows who will be holding.
   */
  pendingUsd: number;
  /**
   * What this wallet would get from each waiting pool if the epoch were built from the holder samples
   * taken so far. An estimate: the epoch adds a snapshot of its own and holdings keep changing.
   */
  estimates: HolderEstimate[];
  /** This wallet's holder rewards, token by token, across published epochs. */
  byToken: { mint: string; symbol: string | null; amountUsd: number; epochs: number }[];
  /** Every token's holder pool: what is waiting for the next snapshot and what has been paid. */
  pools: HolderPool[];
}

const EMPTY = (wallet: string | null): CashbackSummary => ({
  configured: false,
  wallet,
  holderEarnedUsd: 0,
  creatorAccruedUsd: 0,
  paidUsd: 0,
  committedUsd: 0,
  pendingUsd: 0,
  estimates: [],
  byToken: [],
  pools: [],
});

/** The fee Coorwa earns on a launchpad fill of this size, in the same units as `valueUsd`. */
export function launchpadReferralFee(valueUsd: number): number {
  return valueUsd * (MOMOSWAP_TRADE_FEE_BPS / 10_000) * MOMOSWAP_REFERRAL_SHARE;
}

export async function summarise(wallet: string | null): Promise<CashbackSummary> {
  if (!dbEnabled || !db) return EMPTY(wallet);

  const { fills, claims, epochs, holderRewards } = schema;

  // The pools are global and cheap: sums over three tables.
  const pools = (await holderPools(new Date())).slice(0, 50);

  if (!wallet) return { ...EMPTY(null), configured: true, pools };

  const [mine, [asCreator], [committed], estimates] = await Promise.all([
    db
      .select({
        mint: holderRewards.mint,
        amountUsd: sql<number>`coalesce(sum(${holderRewards.amountUsd}), 0)`,
        epochs: sql<number>`count(distinct ${holderRewards.epoch})`,
      })
      .from(holderRewards)
      .innerJoin(epochs, eq(holderRewards.epoch, epochs.index))
      .where(and(eq(holderRewards.wallet, wallet), eq(epochs.status, "published")))
      .groupBy(holderRewards.mint)
      .orderBy(desc(sql`sum(${holderRewards.amountUsd})`)),
    db
      .select({ creatorUsd: feeShareSql("creator") })
      .from(fills)
      .where(eq(fills.creator, wallet)),
    // Two numbers out of the same table. Paid is what the vault has actually handed over; committed
    // also counts a published epoch the wallet has not got round to claiming yet, because that money
    // is already reserved on chain and must not be promised twice.
    db
      .select({
        paidUsd: sql<number>`coalesce(sum(case when ${claims.claimedAt} is not null then ${claims.amountUsd} else 0 end), 0)`,
        committedUsd: sql<number>`coalesce(sum(case when ${claims.claimedAt} is not null or ${epochs.deadline} > now() then ${claims.amountUsd} else 0 end), 0)`,
      })
      .from(claims)
      .innerJoin(epochs, eq(claims.epoch, epochs.index))
      .where(and(eq(claims.wallet, wallet), eq(epochs.status, "published"))),
    holderEstimates(wallet),
  ]);

  const symbols = new Map(pools.map((p) => [p.mint, p.symbol]));
  const byToken = mine.map((r) => ({
    mint: r.mint,
    symbol: symbols.get(r.mint) ?? null,
    amountUsd: Number(r.amountUsd ?? 0),
    epochs: Number(r.epochs ?? 0),
  }));

  const holderEarnedUsd = byToken.reduce((sum, t) => sum + t.amountUsd, 0);
  const creatorAccruedUsd = Number(asCreator?.creatorUsd ?? 0);
  const paidUsd = Number(committed?.paidUsd ?? 0);
  const committedUsd = Number(committed?.committedUsd ?? 0);

  return {
    configured: true,
    wallet,
    holderEarnedUsd,
    creatorAccruedUsd,
    paidUsd,
    committedUsd,
    pendingUsd: Math.max(0, holderEarnedUsd + creatorAccruedUsd - committedUsd),
    estimates,
    byToken,
    pools,
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
