/**
 * Holder samples: who held each paired token, at moments nobody can predict.
 *
 * A single snapshot at payout time could be gamed by buying just before it and selling just after.
 * So holders are sampled at random moments through the day, and the daily run shares each token's
 * pool by the sum of every sample since the last run (`rewards-ledger.ts`). To be paid in full a
 * wallet has to hold through the day, not for one minute of it.
 *
 * Server only.
 */
import { and, gt, inArray, lte, sql } from "drizzle-orm";
import { db, dbEnabled, schema } from "./db";
import { snapshotHolders } from "./holders";
import { rewardPools } from "./rewards-ledger";

/**
 * Thrown for the cases a caller should answer with a status of its own, rather than a bare 500.
 *
 * The field is declared rather than written as a constructor parameter property, because the test
 * runner strips types without compiling them and does not support that syntax.
 */
export class HolderSampleError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "HolderSampleError";
    this.status = status;
  }
}

function requireDb() {
  if (!dbEnabled || !db) {
    throw new HolderSampleError("holder rewards are not configured here (no DATABASE_URL)", 503);
  }
  return db;
}

// --- sharing a pool ------------------------------------------------------------------------------

/** One wallet's share of one token's holder pool. */
export interface HolderAllocation {
  mint: string;
  wallet: string;
  balanceRaw: bigint;
  amountUsd: number;
}

/**
 * Share each token's waiting pool out over the wallets holding it, in proportion to what they hold.
 *
 * A token's pool is everything its holders are owed and have not yet been given. All of it goes to
 * the wallets that held the token across the samples. Having traded it, or having held it last
 * week, earns nothing on its own; holding it now does.
 *
 * A token nobody eligible holds allocates nothing, and its pool waits for the next run rather than
 * being lost or handed to somebody else.
 *
 * Balances are weights, compared as exact integers and only turned into a fraction at the end, so
 * two holders of the same amount always receive the same share.
 */
export function holderAllocationsFrom(args: {
  waitingByMint: ReadonlyMap<string, number>;
  holders: ReadonlyMap<string, ReadonlyMap<string, bigint>>;
}): HolderAllocation[] {
  const out: HolderAllocation[] = [];
  for (const [mint, waiting] of args.waitingByMint) {
    if (!(waiting > 0)) continue;
    const held = args.holders.get(mint);
    if (!held || held.size === 0) continue;

    let total = 0n;
    for (const raw of held.values()) if (raw > 0n) total += raw;
    if (total === 0n) continue;

    for (const [wallet, raw] of held) {
      if (raw <= 0n) continue;
      // Scaled to parts per billion first, so the division is exact integer work on any supply.
      const ppb = Number((raw * 1_000_000_000n) / total);
      out.push({ mint, wallet, balanceRaw: raw, amountUsd: (waiting * ppb) / 1_000_000_000 });
    }
  }
  return out;
}

// --- holder samples ------------------------------------------------------------------------------

/** The least time between two samples, so a burst of cron calls cannot stack them. */
export const SAMPLE_MIN_GAP_MS = 30 * 60 * 1000;
/** The most, so a token is sampled at least this often however the dice fall. */
export const SAMPLE_MAX_GAP_MS = 2 * 60 * 60 * 1000;
/**
 * The chance a call between the two takes a sample. With a call every five minutes that puts a
 * sample roughly an hour apart on average, at a moment nobody can know in advance.
 */
export const SAMPLE_CHANCE = 0.15;

/**
 * Whether a scheduled call should take a sample now.
 *
 * The schedule itself is public and fixed, so sampling on it would let a wallet hold only across the
 * published minutes. Rolling a die on each call instead leaves the moment unpredictable while the
 * two bounds keep the rate sensible. `roll` is passed in so the rule can be tested.
 */
export function shouldSample(lastAt: Date | null, now: Date, roll: number): boolean {
  if (!lastAt) return true;
  const gap = now.getTime() - lastAt.getTime();
  if (gap < SAMPLE_MIN_GAP_MS) return false;
  if (gap >= SAMPLE_MAX_GAP_MS) return true;
  return roll < SAMPLE_CHANCE;
}

/**
 * One token's holder weights over a run's window: every sample's balance, summed per wallet.
 *
 * A wallet absent from a sample held nothing then and adds nothing for it, so a wallet that held for
 * a tenth of the samples weighs a tenth of one that held throughout. `current` is a snapshot taken
 * as the run is allocated, counted as one more sample. `samples` is how many went in, which turns a
 * summed weight back into an average balance for the record.
 */
export function holderWeightsFrom(
  rows: readonly { takenAt: Date; wallet: string; balanceRaw: bigint }[],
  current: ReadonlyMap<string, bigint> | null,
): { weights: Map<string, bigint>; samples: number } {
  const weights = new Map<string, bigint>();
  const moments = new Set<number>();
  for (const r of rows) {
    moments.add(r.takenAt.getTime());
    if (r.balanceRaw > 0n) weights.set(r.wallet, (weights.get(r.wallet) ?? 0n) + r.balanceRaw);
  }
  if (current) {
    for (const [wallet, raw] of current) {
      if (raw > 0n) weights.set(wallet, (weights.get(wallet) ?? 0n) + raw);
    }
  }
  return { weights, samples: moments.size + (current ? 1 : 0) };
}

/** Every sample row for these mints inside (from, to], grouped by mint. */
export async function samplesIn(mints: readonly string[], from: Date, to: Date) {
  const out = new Map<string, { takenAt: Date; wallet: string; balanceRaw: bigint }[]>();
  if (mints.length === 0) return out;
  const conn = requireDb();
  const { holderSamples } = schema;
  const rows = await conn
    .select({
      mint: holderSamples.mint,
      takenAt: holderSamples.takenAt,
      wallet: holderSamples.wallet,
      balanceRaw: holderSamples.balanceRaw,
    })
    .from(holderSamples)
    .where(
      and(
        inArray(holderSamples.mint, [...mints]),
        gt(holderSamples.takenAt, from),
        lte(holderSamples.takenAt, to),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.mint);
    if (list) list.push(r);
    else out.set(r.mint, [r]);
  }
  return out;
}

export interface SampleResult {
  sampled: boolean;
  reason: string;
  takenAt: string | null;
  mints: number;
  rows: number;
}

/**
 * Take a holder sample if the dice say so: every token with rewards waiting, stored under one time.
 *
 * Called on a schedule through the sample endpoint. A token with nothing waiting is not sampled,
 * because nothing would be paid from it; if a pool fills later, the samples from then on are what
 * count.
 */
export async function recordHolderSample(
  now = new Date(),
  roll = Math.random(),
): Promise<SampleResult> {
  const conn = requireDb();
  const { holderSamples } = schema;

  const [last] = await conn
    .select({ at: sql<Date | null>`max(${holderSamples.takenAt})` })
    .from(holderSamples);
  const lastAt = last?.at ? new Date(last.at) : null;
  if (!shouldSample(lastAt, now, roll)) {
    return { sampled: false, reason: "not this time", takenAt: null, mints: 0, rows: 0 };
  }

  // Only tokens that have a pair can be paid, so only those are worth sampling.
  const waiting = (await rewardPools(now)).filter((p) => p.ticker && p.holdersWaitingUsd > 0);
  const snapshots = await snapshotHolders(waiting.map((p) => p.mint));
  const rows = snapshots.flatMap((s) =>
    [...s.holders].map(([wallet, balanceRaw]) => ({ takenAt: now, mint: s.mint, wallet, balanceRaw })),
  );

  // A marker row under no mint records the time even when nothing was held, or the gap rule would
  // retry the sample on every call. No query for a real mint ever reads it.
  await conn
    .insert(holderSamples)
    .values({ takenAt: now, mint: "", wallet: "", balanceRaw: 0n })
    .onConflictDoNothing();
  for (let i = 0; i < rows.length; i += 500) {
    await conn
      .insert(holderSamples)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing();
  }
  return {
    sampled: true,
    reason: waiting.length === 0 ? "no token has rewards waiting" : "sampled",
    takenAt: now.toISOString(),
    mints: waiting.length,
    rows: rows.length,
  };
}
