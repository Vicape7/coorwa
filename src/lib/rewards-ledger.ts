/**
 * Who is owed what, in which asset, and what has been paid.
 *
 * Every fee Coorwa collects on a token belongs to that token: `REWARD_SPLIT.holders` of it to the
 * wallets holding it, the rest to its creator, and a pair payment entirely to its holders. A fee on a
 * token whose creator nobody can name goes entirely to its holders too, rather than staying with the
 * operator for want of a recipient. The creator is paid from fees only: their own holding never
 * counts toward the holders' share. The money
 * itself sits in the operator wallet. This file is the ledger that says whose it is, and
 * `payout-cycle.ts` is what moves it.
 *
 * Once a day a run shares every token's waiting pool over its holders, weighted by what each wallet
 * held across the holder samples taken since the last run, and writes one line per wallet per token
 * in the token's pair asset. A wallet's lines in one asset are paid together once they reach
 * `PAYOUT_MIN_USD`, so a small holder is paid later rather than never. Accrual stays in USD and is
 * converted only when the asset is bought, because an xStock rebases and a debt in its units would
 * quietly change value.
 *
 * Server only.
 */
import { and, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { holderAllocationsFrom, holderWeightsFrom, samplesIn } from "./holder-samples";
import { listedByMint } from "./listings";
import { benchmarks } from "./launches";
import { tokenCreator } from "./creators";
import { fetchTokens } from "./cookiescan";
import { REWARD_SPLIT, PAYOUT_EVERY_MS, PAYOUT_MIN_USD } from "./config";

function requireDb() {
  if (!db) throw new Error("the rewards ledger needs DATABASE_URL");
  return db;
}

// --- pure arithmetic ------------------------------------------------------------------------------

/**
 * Split a raw amount by USD weight, in whole units, without creating or losing any.
 *
 * Each share is floored and the units left over go one at a time to the largest remainders, so the
 * parts always add up to the total exactly. That matters because the total is what one swap actually
 * bought: a part rounded up would try to send a unit the operator does not have.
 */
export function splitRaw(
  total: bigint,
  shares: readonly { key: string; usd: number }[],
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  // Weights as whole nano-dollars, so every division below is exact and the remainders are smaller
  // than one unit each, which is what lets the leftover go out one unit per part.
  const weights = shares.map((s) => BigInt(Math.max(0, Math.round(s.usd * 1e9))));
  const weight = weights.reduce((sum, w) => sum + w, 0n);
  if (total <= 0n || weight === 0n) {
    for (const s of shares) out.set(s.key, 0n);
    return out;
  }

  const parts = shares.map((s, i) => {
    const exact = total * weights[i];
    return { key: s.key, floor: exact / weight, rest: exact % weight };
  });

  let left = total - parts.reduce((sum, p) => sum + p.floor, 0n);
  for (const p of [...parts].sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : 0))) {
    if (left <= 0n) break;
    p.floor += 1n;
    left -= 1n;
  }
  for (const p of parts) out.set(p.key, p.floor);
  return out;
}

/**
 * Which unpaid lines are paid now: a wallet's lines in one asset, once together they reach the
 * minimum. Returns their ids.
 */
export function payableLines(
  lines: readonly { id: number; wallet: string; ticker: string; amountUsd: number }[],
  minUsd: number,
): number[] {
  const groups = new Map<string, { usd: number; ids: number[] }>();
  for (const l of lines) {
    const key = `${l.wallet}|${l.ticker}`;
    const g = groups.get(key) ?? { usd: 0, ids: [] };
    g.usd += l.amountUsd;
    g.ids.push(l.id);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.usd >= minUsd).flatMap((g) => g.ids);
}

/** Each line's share of what its asset's swap bought, split by wallet and then within a wallet. */
export function lineAmounts(
  lines: readonly { id: number; wallet: string; ticker: string; amountUsd: number }[],
  boughtByTicker: ReadonlyMap<string, bigint>,
): Map<number, bigint> {
  const out = new Map<number, bigint>();
  const tickers = new Set(lines.map((l) => l.ticker));
  for (const ticker of tickers) {
    const ofTicker = lines.filter((l) => l.ticker === ticker);
    const byWallet = new Map<string, number>();
    for (const l of ofTicker) byWallet.set(l.wallet, (byWallet.get(l.wallet) ?? 0) + l.amountUsd);
    const perWallet = splitRaw(
      boughtByTicker.get(ticker) ?? 0n,
      [...byWallet].map(([key, usd]) => ({ key, usd })),
    );
    for (const [wallet, raw] of perWallet) {
      const own = ofTicker.filter((l) => l.wallet === wallet);
      const perLine = splitRaw(
        raw,
        own.map((l) => ({ key: String(l.id), usd: l.amountUsd })),
      );
      for (const [id, v] of perLine) out.set(Number(id), v);
    }
  }
  return out;
}

/**
 * Below this a pool counts as empty. Sums of float8 fees minus sums of allocated lines leave a few
 * billionths of a dollar behind, and a pool that holds only that would be sampled every day and
 * shown on the rewards page as a payout of $0.000000002.
 */
export const DUST_USD = 0.000001;

/** What a token's holders are still owed: accrued less allocated, with rounding dust read as zero. */
export function waitingUsd(accruedUsd: number, allocatedUsd: number): number {
  const left = accruedUsd - allocatedUsd;
  return left < DUST_USD ? 0 : left;
}

/**
 * Holder weights with the token's creator taken out. The creator is paid `REWARD_SPLIT.creator` of
 * the fees and nothing for holding their own token, so their tokens do not dilute real holders either.
 */
export function withoutCreators(
  weights: ReadonlyMap<string, bigint>,
  creators: ReadonlySet<string>,
): Map<string, bigint> {
  return new Map([...weights].filter(([wallet]) => !creators.has(wallet)));
}

/** Every wallet counted as a token's creator: the one its fills named and the one resolved now. */
async function creatorsByMint(pools: readonly RewardPool[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  await Promise.all(
    pools.map(async (p) => {
      const wallets = new Set<string>();
      if (p.creator) wallets.add(p.creator);
      const resolved = await tokenCreator(p.mint).catch(() => null);
      if (resolved) wallets.add(resolved.wallet);
      out.set(p.mint, wallets);
    }),
  );
  return out;
}

// --- pools ------------------------------------------------------------------------------------------

export interface RewardPool {
  mint: string;
  symbol: string | null;
  /** The asset the token's holders are paid in. Null while the token has no pair. */
  ticker: string | null;
  /** Everything ever owed to the token's holders. */
  holdersAccruedUsd: number;
  /** What runs have already shared out to holders, paid or waiting for the minimum. */
  holdersAllocatedUsd: number;
  /** What the next run shares out. */
  holdersWaitingUsd: number;
  /** What has actually reached holders' wallets. */
  holdersPaidUsd: number;
  creator: string | null;
  creatorAccruedUsd: number;
  creatorAllocatedUsd: number;
  /** What has actually reached the creator's wallet. */
  creatorPaidUsd: number;
}

/** Every token's pool as of a cutoff. */
export async function rewardPools(asOf = new Date()): Promise<RewardPool[]> {
  const conn = requireDb();
  const { fills, listings, payoutLines } = schema;

  const [holderFees, creatorFees, listingRows, allocated, pins, listed] = await Promise.all([
    conn
      .select({
        mint: fills.mint,
        symbol: sql<string | null>`max(${fills.symbol})`,
        // A fill with no creator has nobody to pay the creator's part to, so its holders get all of it.
        usd: sql<number>`coalesce(sum(${fills.feeUsd} * case when ${fills.creator} is null then 1 else ${REWARD_SPLIT.holders}::float8 end), 0)`,
      })
      .from(fills)
      .where(lte(fills.createdAt, asOf))
      .groupBy(fills.mint),
    conn
      .select({
        mint: fills.mint,
        creator: fills.creator,
        usd: sql<number>`coalesce(sum(${fills.feeUsd}), 0) * ${REWARD_SPLIT.creator}::float8`,
      })
      .from(fills)
      .where(and(lte(fills.createdAt, asOf), isNotNull(fills.creator)))
      .groupBy(fills.mint, fills.creator),
    conn
      .select({ mint: listings.mint, usd: sql<number>`coalesce(sum(${listings.paidUsd}), 0)` })
      .from(listings)
      .where(lte(listings.createdAt, asOf))
      .groupBy(listings.mint),
    conn
      .select({
        mint: payoutLines.mint,
        role: payoutLines.role,
        usd: sql<number>`coalesce(sum(${payoutLines.amountUsd}), 0)`,
        paid: sql<number>`coalesce(sum(case when ${payoutLines.status} = 'sent' then ${payoutLines.amountUsd} else 0 end), 0)`,
      })
      .from(payoutLines)
      .groupBy(payoutLines.mint, payoutLines.role),
    benchmarks(),
    listedByMint(),
  ]);

  const pools = new Map<string, RewardPool>();
  const pool = (mint: string) => {
    let p = pools.get(mint);
    if (!p) {
      p = {
        mint,
        symbol: null,
        ticker: pins.get(mint) ?? listed.get(mint) ?? null,
        holdersAccruedUsd: 0,
        holdersAllocatedUsd: 0,
        holdersWaitingUsd: 0,
        holdersPaidUsd: 0,
        creator: null,
        creatorAccruedUsd: 0,
        creatorAllocatedUsd: 0,
        creatorPaidUsd: 0,
      };
      pools.set(mint, p);
    }
    return p;
  };

  for (const f of holderFees) {
    const p = pool(f.mint);
    p.holdersAccruedUsd += Number(f.usd ?? 0);
    p.symbol = f.symbol ?? p.symbol;
  }
  for (const c of creatorFees) {
    const p = pool(c.mint);
    // A token's creator is resolved per fill; if that ever changed, the latest name is shown and
    // every share is still paid to the wallet each fill named (see `allocateRun`).
    p.creator = c.creator;
    p.creatorAccruedUsd += Number(c.usd ?? 0);
  }
  for (const l of listingRows) pool(l.mint).holdersAccruedUsd += Number(l.usd ?? 0);
  for (const a of allocated) {
    const p = pool(a.mint);
    if (a.role === "creator") {
      p.creatorAllocatedUsd += Number(a.usd ?? 0);
      p.creatorPaidUsd += Number(a.paid ?? 0);
    } else {
      p.holdersAllocatedUsd += Number(a.usd ?? 0);
      p.holdersPaidUsd += Number(a.paid ?? 0);
    }
  }
  for (const p of pools.values()) {
    p.holdersWaitingUsd = waitingUsd(p.holdersAccruedUsd, p.holdersAllocatedUsd);
  }
  // Only fills carry a symbol, so a token that has a pair but no trade yet is named from the registry.
  if ([...pools.values()].some((p) => !p.symbol)) {
    const tokens = await fetchTokens().catch(() => []);
    const symbolOf = new Map(tokens.map((t) => [t.mint, t.metadata?.symbol?.trim() || null]));
    for (const p of pools.values()) p.symbol ??= symbolOf.get(p.mint) ?? null;
  }
  return [...pools.values()].sort((a, b) => b.holdersAccruedUsd - a.holdersAccruedUsd);
}

// --- runs -------------------------------------------------------------------------------------------

/** Where the open window starts: the cutoff of the latest run, or the beginning of time. */
export async function lastRunAsOf(): Promise<Date> {
  const conn = requireDb();
  const [last] = await conn
    .select({ asOf: schema.payoutCycles.asOf })
    .from(schema.payoutCycles)
    .orderBy(desc(schema.payoutCycles.asOf))
    .limit(1);
  return last?.asOf ?? new Date(0);
}

/**
 * When the next run is due: `PAYOUT_EVERY_MS` after the first holder sample since the last run.
 * Null while nothing has been sampled, which means no token has had anything waiting.
 */
export async function nextRunDueAt(): Promise<Date | null> {
  const conn = requireDb();
  const { holderSamples } = schema;
  const from = await lastRunAsOf();
  const [first] = await conn
    .select({ at: sql<Date | null>`min(${holderSamples.takenAt})` })
    .from(holderSamples)
    .where(and(ne(holderSamples.mint, ""), gt(holderSamples.takenAt, from)));
  return first?.at ? new Date(new Date(first.at).getTime() + PAYOUT_EVERY_MS) : null;
}

export interface AllocatedRun {
  /** Zero when another call was already allocating this run and this one did nothing. */
  cycleId: number;
  totalUsd: number;
  lines: number;
}

/**
 * The lock a run is allocated under. Any constant will do, as long as both schedulers pick the same
 * one: what matters is that only one transaction at a time can be inside `allocateRun`.
 */
const RUN_LOCK = 8_190_119;

/**
 * Share every waiting pool out, and queue whatever has reached the minimum, as one new run.
 *
 * Holders are weighed by their balances across the samples since the last run, and by nothing else:
 * the moment a run happens is public, so anything read at that moment could be held across on
 * purpose. A token without a pair keeps its pool until it has one, because there is no asset to pay
 * it in; a token nobody eligible held keeps its pool for the next run.
 */
export async function allocateRun(asOf: Date, cookPriceUsd: number): Promise<AllocatedRun> {
  const conn = requireDb();
  const { fills, payoutCycles, payoutLines } = schema;

  const pools = await rewardPools(asOf);
  const from = await lastRunAsOf();

  const waiting = pools.filter((p) => p.ticker && p.holdersWaitingUsd > 0);
  const mints = waiting.map((p) => p.mint);
  const [sampled, creators] = await Promise.all([
    samplesIn(mints, from, asOf),
    creatorsByMint(waiting),
  ]);

  const weights = new Map<string, Map<string, bigint>>();
  const counts = new Map<string, number>();
  for (const mint of mints) {
    const w = holderWeightsFrom(sampled.get(mint) ?? []);
    weights.set(mint, withoutCreators(w.weights, creators.get(mint) ?? new Set()));
    counts.set(mint, w.samples);
  }
  const holderLines = holderAllocationsFrom({
    waitingByMint: new Map(waiting.map((p) => [p.mint, p.holdersWaitingUsd])),
    holders: weights,
  });

  // The creator's share per wallet the fills named, less what earlier runs allocated to that wallet.
  const [creatorAccrued, creatorAllocated] = await Promise.all([
    conn
      .select({
        mint: fills.mint,
        wallet: fills.creator,
        usd: sql<number>`coalesce(sum(${fills.feeUsd}), 0) * ${REWARD_SPLIT.creator}::float8`,
      })
      .from(fills)
      .where(and(lte(fills.createdAt, asOf), isNotNull(fills.creator)))
      .groupBy(fills.mint, fills.creator),
    conn
      .select({
        mint: payoutLines.mint,
        wallet: payoutLines.wallet,
        usd: sql<number>`coalesce(sum(${payoutLines.amountUsd}), 0)`,
      })
      .from(payoutLines)
      .where(eq(payoutLines.role, "creator"))
      .groupBy(payoutLines.mint, payoutLines.wallet),
  ]);
  const tickerOf = new Map(pools.map((p) => [p.mint, p.ticker]));
  const givenToCreator = new Map(
    creatorAllocated.map((r) => [`${r.mint}|${r.wallet}`, Number(r.usd ?? 0)]),
  );

  return conn.transaction(async (tx) => {
    // Held until this transaction ends, so a second caller waits here rather than sharing the same
    // pools out a second time. Two schedulers firing in the same minute would otherwise both read
    // "nothing allocated yet" and queue every holder twice, and the operator would pay twice.
    await tx.execute(sql`select pg_advisory_xact_lock(${RUN_LOCK}::bigint)`);
    const [state] = await tx
      .select({
        latest: sql<Date | null>`max(${payoutCycles.asOf})`,
        open: sql<number>`count(*) filter (where ${payoutCycles.status} in ('allocated', 'bridging', 'bridged', 'sending'))`,
      })
      .from(payoutCycles);
    // Whatever this call read before the lock is stale if a run appeared in the meantime, so it
    // hands the work to that run instead of duplicating it.
    const latest = state?.latest ? new Date(state.latest).getTime() : 0;
    if (Number(state?.open ?? 0) > 0 || latest !== from.getTime()) {
      return { cycleId: 0, totalUsd: 0, lines: 0 };
    }

    const [cycle] = await tx
      .insert(payoutCycles)
      .values({ asOf, status: "allocated", cookPriceUsd })
      .returning({ id: payoutCycles.id });

    const rows: (typeof payoutLines.$inferInsert)[] = [];
    for (const a of holderLines) {
      if (!(a.amountUsd > 0)) continue;
      rows.push({
        allocatedIn: cycle.id,
        wallet: a.wallet,
        mint: a.mint,
        ticker: tickerOf.get(a.mint)!,
        role: "holder",
        // Stored as the average balance across the samples, which is what a reader expects to see.
        balanceRaw: a.balanceRaw / BigInt(Math.max(1, counts.get(a.mint) ?? 1)),
        amountUsd: a.amountUsd,
      });
    }
    for (const c of creatorAccrued) {
      const ticker = tickerOf.get(c.mint);
      if (!c.wallet || !ticker) continue;
      const owed = Number(c.usd ?? 0) - (givenToCreator.get(`${c.mint}|${c.wallet}`) ?? 0);
      if (!(owed > 0.000001)) continue;
      rows.push({
        allocatedIn: cycle.id,
        wallet: c.wallet,
        mint: c.mint,
        ticker,
        role: "creator",
        balanceRaw: 0n,
        amountUsd: owed,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(payoutLines).values(rows.slice(i, i + 500));
    }

    const unpaid = await tx
      .select({
        id: payoutLines.id,
        wallet: payoutLines.wallet,
        ticker: payoutLines.ticker,
        amountUsd: payoutLines.amountUsd,
      })
      .from(payoutLines)
      .where(eq(payoutLines.status, "allocated"));
    const ids = payableLines(unpaid, PAYOUT_MIN_USD);
    for (let i = 0; i < ids.length; i += 500) {
      await tx
        .update(payoutLines)
        .set({ status: "queued", paidIn: cycle.id })
        .where(inArray(payoutLines.id, ids.slice(i, i + 500)));
    }

    const totalUsd = unpaid
      .filter((l) => ids.includes(l.id))
      .reduce((sum, l) => sum + l.amountUsd, 0);
    await tx
      .update(payoutCycles)
      .set({ totalUsd, status: totalUsd > 0 ? "allocated" : "empty", updatedAt: new Date() })
      .where(eq(payoutCycles.id, cycle.id));

    return { cycleId: cycle.id, totalUsd, lines: rows.length };
  });
}

// --- what a wallet sees -------------------------------------------------------------------------------

export interface WalletRewards {
  /** Allocated but not yet paid, per token and role. Paid once a wallet's lines in one asset reach the minimum. */
  pending: { mint: string; ticker: string; role: string; usd: number }[];
  /** Sent, newest first. */
  paid: {
    ticker: string;
    usd: number;
    assetRaw: string | null;
    signature: string | null;
    at: string;
    role: string;
    mint: string;
  }[];
}

export async function walletRewards(wallet: string): Promise<WalletRewards> {
  const conn = requireDb();
  const { payoutLines } = schema;
  const rows = await conn
    .select()
    .from(payoutLines)
    .where(eq(payoutLines.wallet, wallet))
    .orderBy(desc(payoutLines.createdAt))
    .limit(500);

  const pending = new Map<string, WalletRewards["pending"][number]>();
  const paid: WalletRewards["paid"] = [];
  for (const r of rows) {
    if (r.status === "sent") {
      paid.push({
        ticker: r.ticker,
        usd: r.amountUsd,
        assetRaw: r.assetRaw?.toString() ?? null,
        signature: r.signature,
        at: r.createdAt.toISOString(),
        role: r.role,
        mint: r.mint,
      });
    } else if (r.status !== "failed") {
      // A failed line is neither waiting nor paid: the run could not reach the account, and the
      // amount stays counted as the pool's so it is never handed out a second time.
      const key = `${r.mint}|${r.role}`;
      const line = pending.get(key) ?? { mint: r.mint, ticker: r.ticker, role: r.role, usd: 0 };
      line.usd += r.amountUsd;
      pending.set(key, line);
    }
  }
  return { pending: [...pending.values()], paid };
}

export interface HolderEstimate {
  mint: string;
  symbol: string | null;
  ticker: string;
  waitingUsd: number;
  /** This wallet's part of the token's summed weight so far, 0 to 1. */
  share: number;
  estimatedUsd: number;
  samples: number;
}

/**
 * What a wallet would get from each waiting pool if the run happened now, from the samples so far.
 * An estimate: more samples are taken before the run, and holdings keep changing until then.
 */
export async function holderEstimates(wallet: string): Promise<HolderEstimate[]> {
  const waiting = (await rewardPools()).filter((p) => p.ticker && p.holdersWaitingUsd > 0);
  const [samples, creators] = await Promise.all([
    samplesIn(
      waiting.map((p) => p.mint),
      await lastRunAsOf(),
      new Date(),
    ),
    creatorsByMint(waiting),
  ]);

  const out: HolderEstimate[] = [];
  for (const pool of waiting) {
    const sampled = holderWeightsFrom(samples.get(pool.mint) ?? []);
    const weights = withoutCreators(sampled.weights, creators.get(pool.mint) ?? new Set());
    const count = sampled.samples;
    const mine = weights.get(wallet);
    if (!mine) continue;
    let total = 0n;
    for (const w of weights.values()) total += w;
    const share = Number((mine * 1_000_000n) / total) / 1_000_000;
    out.push({
      mint: pool.mint,
      symbol: pool.symbol,
      ticker: pool.ticker!,
      waitingUsd: pool.holdersWaitingUsd,
      share,
      estimatedUsd: pool.holdersWaitingUsd * share,
      samples: count,
    });
  }
  return out.sort((a, b) => b.estimatedUsd - a.estimatedUsd);
}

export interface RunRow {
  id: number;
  asOf: string;
  status: string;
  totalUsd: number;
  costsUsd: number | null;
  wallets: number;
  bridgeSignature: string | null;
  note: string | null;
}

/** The latest payout runs, newest first, for anyone to audit. */
export async function recentRuns(limit = 10): Promise<RunRow[]> {
  const conn = requireDb();
  const { payoutCycles, payoutLines } = schema;
  const runs = await conn
    .select()
    .from(payoutCycles)
    .where(ne(payoutCycles.status, "empty"))
    .orderBy(desc(payoutCycles.id))
    .limit(limit);
  if (runs.length === 0) return [];

  const counts = await conn
    .select({
      cycle: payoutLines.paidIn,
      wallets: sql<number>`count(distinct ${payoutLines.wallet})`,
    })
    .from(payoutLines)
    .where(inArray(payoutLines.paidIn, runs.map((r) => r.id)))
    .groupBy(payoutLines.paidIn);
  const walletsOf = new Map(counts.map((c) => [c.cycle, Number(c.wallets ?? 0)]));

  return runs.map((r) => ({
    id: r.id,
    asOf: r.asOf.toISOString(),
    status: r.status,
    totalUsd: r.totalUsd,
    costsUsd: r.costsUsd,
    wallets: walletsOf.get(r.id) ?? 0,
    bridgeSignature: r.bridgeSignature,
    note: r.note,
  }));
}
