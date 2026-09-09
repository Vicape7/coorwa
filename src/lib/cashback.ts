/**
 * Cashback accounting.
 *
 * The money is real and already exists: MomoSwap pays a referrer 20% of its 1% curve fee, and the
 * aggregator path carries Corwa's own router margin. Neither is invented - with no referrer named,
 * MomoSwap simply keeps that slice - so naming Corwa costs a trader nothing and is what funds the
 * rebate.
 *
 * Accrual is split per `CASHBACK_SPLIT`: half back to the trader who generated the fee, a share to
 * the creator of the token traded, and the rest returned to liquidity. Every row it reads was
 * written only after a transaction confirmed on-chain, so a balance here is checkable against the
 * explorer rather than taken on trust.
 */
import { and, eq, sql, desc, gte } from "drizzle-orm";
import { db, dbEnabled, schema } from "./db";
import { CASHBACK_SPLIT, MOMOSWAP_TRADE_FEE_BPS, MOMOSWAP_REFERRAL_SHARE } from "./config";

export interface CashbackSummary {
  configured: boolean;
  wallet: string | null;
  /** Everything the wallet has generated, before the split. */
  feesGeneratedUsd: number;
  traderAccruedUsd: number;
  creatorAccruedUsd: number;
  paidUsd: number;
  claimableUsd: number;
  fillCount: number;
  volumeUsd: number;
  recent: {
    signature: string;
    symbol: string | null;
    side: string;
    valueUsd: number;
    feeUsd: number;
    createdAt: string;
  }[];
  leaderboard: { wallet: string; volumeUsd: number; accruedUsd: number }[];
}

const EMPTY = (wallet: string | null): CashbackSummary => ({
  configured: false,
  wallet,
  feesGeneratedUsd: 0,
  traderAccruedUsd: 0,
  creatorAccruedUsd: 0,
  paidUsd: 0,
  claimableUsd: 0,
  fillCount: 0,
  volumeUsd: 0,
  recent: [],
  leaderboard: [],
});

/** The fee Corwa earns on a launchpad fill of this size, in the same units as `valueUsd`. */
export function launchpadReferralFee(valueUsd: number): number {
  return valueUsd * (MOMOSWAP_TRADE_FEE_BPS / 10_000) * MOMOSWAP_REFERRAL_SHARE;
}

export async function summarise(wallet: string | null): Promise<CashbackSummary> {
  if (!dbEnabled || !db) return EMPTY(wallet);

  const { fills, payouts } = schema;

  // Leaderboard is global and cheap to keep alongside the wallet's own numbers.
  const board = await db
    .select({
      wallet: fills.wallet,
      volumeUsd: sql<number>`sum(${fills.valueUsd})`,
      feeUsd: sql<number>`sum(${fills.feeUsd})`,
    })
    .from(fills)
    .groupBy(fills.wallet)
    .orderBy(desc(sql`sum(${fills.valueUsd})`))
    .limit(10);

  const leaderboard = board.map((r) => ({
    wallet: r.wallet,
    volumeUsd: Number(r.volumeUsd ?? 0),
    accruedUsd: Number(r.feeUsd ?? 0) * CASHBACK_SPLIT.trader,
  }));

  if (!wallet) return { ...EMPTY(null), configured: true, leaderboard };

  const [mine] = await db
    .select({
      fills: sql<number>`count(*)`,
      volumeUsd: sql<number>`coalesce(sum(${fills.valueUsd}), 0)`,
      feeUsd: sql<number>`coalesce(sum(${fills.feeUsd}), 0)`,
    })
    .from(fills)
    .where(eq(fills.wallet, wallet));

  const [asCreator] = await db
    .select({ feeUsd: sql<number>`coalesce(sum(${fills.feeUsd}), 0)` })
    .from(fills)
    .where(eq(fills.creator, wallet));

  const [paid] = await db
    .select({ amountUsd: sql<number>`coalesce(sum(${payouts.amountUsd}), 0)` })
    .from(payouts)
    .where(and(eq(payouts.wallet, wallet), sql`${payouts.signature} is not null`));

  const recent = await db
    .select({
      signature: fills.signature,
      symbol: fills.symbol,
      side: fills.side,
      valueUsd: fills.valueUsd,
      feeUsd: fills.feeUsd,
      createdAt: fills.createdAt,
    })
    .from(fills)
    .where(eq(fills.wallet, wallet))
    .orderBy(desc(fills.createdAt))
    .limit(20);

  const feesGeneratedUsd = Number(mine?.feeUsd ?? 0);
  const traderAccruedUsd = feesGeneratedUsd * CASHBACK_SPLIT.trader;
  const creatorAccruedUsd = Number(asCreator?.feeUsd ?? 0) * CASHBACK_SPLIT.creator;
  const paidUsd = Number(paid?.amountUsd ?? 0);

  return {
    configured: true,
    wallet,
    feesGeneratedUsd,
    traderAccruedUsd,
    creatorAccruedUsd,
    paidUsd,
    claimableUsd: Math.max(0, traderAccruedUsd + creatorAccruedUsd - paidUsd),
    fillCount: Number(mine?.fills ?? 0),
    volumeUsd: Number(mine?.volumeUsd ?? 0),
    recent: recent.map((r) => ({
      signature: r.signature,
      symbol: r.symbol,
      side: r.side,
      valueUsd: r.valueUsd,
      feeUsd: r.feeUsd,
      createdAt: r.createdAt.toISOString(),
    })),
    leaderboard,
  };
}

export interface RecordFill {
  signature: string;
  wallet: string;
  source: "swap" | "launchpad";
  mint: string;
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
    rebatedUsd: feesUsd * (CASHBACK_SPLIT.trader + CASHBACK_SPLIT.creator),
    wallets: Number(row?.wallets ?? 0),
    fills: Number(row?.fills ?? 0),
  };
}
