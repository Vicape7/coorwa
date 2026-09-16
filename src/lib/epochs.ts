/**
 * Cashback epochs: the off-chain half of `programs/corwa-vault`.
 *
 * The split the whole design rests on is that Coorwa works out *who is owed what* and the chain
 * decides *whether money moves*. This file is the first half. It reads confirmed fills, works out
 * every wallet's balance, freezes that list as a merkle tree, and hands out one proof at a time.
 * The vault itself never learns a single name.
 *
 * Three rules keep it from paying twice, and they are the only interesting thing here:
 *
 *   1. A balance is committed the moment it lands in a published epoch, and stays committed while
 *      that epoch is claimable, and forever once it has been claimed. So a later epoch cannot
 *      contain it as well.
 *   2. A balance in an epoch that expired unclaimed becomes uncommitted again, because the program
 *      returns that reserve to the vault when the epoch is closed. It rolls into a later epoch
 *      rather than being lost.
 *   3. An epoch row is only marked published after its transaction has been read back from the
 *      chain and its root compared byte for byte. Coorwa cannot talk an epoch into existing.
 *
 * Everything is recorded in USD and converted to COOK once, at publish time, at a rate written
 * onto the epoch row. A fee is earned in USD terms, and a balance carried as "0.4 COOK" would
 * quietly change value between the trade and the payout.
 *
 * Server only: the tree hashes with node:crypto and the browser never needs it. The browser is
 * handed a finished proof by the API.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { db, dbEnabled, schema } from "./db";
import { buildEpochTree, verifyProof, type Entitlement } from "./merkle";
import { fetchCookPriceUsd } from "./cookiescan";
import { snapshotHolders } from "./holders";
import { publisherKeypair } from "./publisher";
import {
  AUTO_EPOCH_EVERY_MS,
  CASHBACK_CLAIM_WINDOW_DAYS,
  CASHBACK_MIN_CLAIM_COOK,
  CASHBACK_SPLIT,
  COOKIE_RPC_URL,
  COOK_DECIMALS,
  VAULT_MINT,
} from "./config";
import {
  VAULT_PROGRAM_ID,
  fetchClaimStatuses,
  fetchEpochs,
  fetchVault,
  isVaultDeployed,
  type VaultSnapshot,
} from "./vault";

const MINT = new PublicKey(VAULT_MINT);
const UNITS_PER_COOK = 10n ** BigInt(COOK_DECIMALS);
const MIN_CLAIM_RAW = BigInt(Math.round(CASHBACK_MIN_CLAIM_COOK * Number(UNITS_PER_COOK)));

export function cookieConnection(): Connection {
  return new Connection(COOKIE_RPC_URL, "confirmed");
}

export function toCook(raw: bigint): number {
  return Number(raw) / Number(UNITS_PER_COOK);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Thrown for the cases an operator needs to read and act on, rather than a bare 500.
 *
 * The field is declared rather than written as a constructor parameter property, because the test
 * runner strips types without compiling them and does not support that syntax.
 */
export class EpochError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "EpochError";
    this.status = status;
  }
}

function requireDb() {
  if (!dbEnabled || !db) {
    throw new EpochError("cashback accounting is not configured here (no DATABASE_URL)", 503);
  }
  return db;
}

// --- what a wallet is owed ---------------------------------------------------------------------

export interface EntitlementLine {
  wallet: string;
  holderUsd: number;
  creatorUsd: number;
  amountUsd: number;
  amountRaw: bigint;
}

export interface Accrual {
  /**
   * Everything the wallet has been given out of holder pools, cumulatively: every published epoch
   * plus the one being built. Split and allocated before it arrives here (`holderAllocationsFrom`),
   * so this function only has to get the subtraction, the conversion and the floor right.
   */
  holderUsd: Map<string, number>;
  /** The creator's share of the fees earned on tokens the wallet launched, after its split. */
  creatorUsd: Map<string, number>;
  /** Already sitting in an epoch: claimed, or published and still inside its window. */
  committedUsd: Map<string, number>;
  cookPriceUsd: number;
}

/**
 * The arithmetic of who is owed what, with the database taken out of it.
 *
 * Kept separate from the queries because this is the part that must not be wrong: a mistake in the
 * subtraction pays somebody twice, and a mistake in the conversion pays them the wrong amount. It
 * is a pure function of three maps, so `tests/epochs.test.ts` can push the awkward cases through
 * it without a Postgres anywhere.
 */
export function entitlementsFrom(accrual: Accrual): EntitlementLine[] {
  const { holderUsd: holderShare, creatorUsd: creatorShare, committedUsd, cookPriceUsd } = accrual;
  if (!(cookPriceUsd > 0)) throw new Error("a COOK price is needed to convert a USD balance");

  const wallets = new Set([...holderShare.keys(), ...creatorShare.keys()]);
  const out: EntitlementLine[] = [];

  for (const wallet of wallets) {
    const holderUsd = holderShare.get(wallet) ?? 0;
    const creatorUsd = creatorShare.get(wallet) ?? 0;
    const amountUsd = holderUsd + creatorUsd - (committedUsd.get(wallet) ?? 0);
    if (!(amountUsd > 0)) continue;

    const raw = BigInt(Math.floor((amountUsd / cookPriceUsd) * Number(UNITS_PER_COOK)));
    // Under the floor a claim costs the claimant more in rent than it pays them. The balance is
    // not dropped: it stays uncommitted and rolls into whichever epoch it finally clears.
    if (raw < MIN_CLAIM_RAW) continue;

    out.push({ wallet, holderUsd, creatorUsd, amountUsd, amountRaw: raw });
  }

  return out.sort((a, b) => b.amountUsd - a.amountUsd);
}

// --- holder pools --------------------------------------------------------------------------------

/** One wallet's share of one token's holder pool in one epoch. */
export interface HolderAllocation {
  mint: string;
  wallet: string;
  balanceRaw: bigint;
  amountUsd: number;
}

/**
 * Share each token's waiting pool out over the wallets holding it, in proportion to what they hold.
 *
 * A token's pool is everything its holders are owed and have not yet been given: the holders' share
 * of every fee earned on it, plus every listing fee paid for its pairs, less what published epochs
 * already allocated. All of it goes to whoever holds the token at this snapshot. Having traded it,
 * or having held it last week, earns nothing on its own; holding it now does.
 *
 * A token nobody eligible holds allocates nothing, and its pool waits for the next epoch rather than
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

/**
 * A listing payment is one transaction that may buy several pairs, and every row it bought carries
 * the whole amount. Split evenly, so a batch of three dollars is a dollar a pair, not three each.
 */
export function listingsPerPair(
  rows: readonly { mint: string; ticker: string; signature: string; paidUsd: number; at: Date }[],
): { pair: string; mint: string; paidUsd: number; at: Date }[] {
  const siblings = new Map<string, number>();
  for (const r of rows) siblings.set(r.signature, (siblings.get(r.signature) ?? 0) + 1);
  return rows.map((r) => ({
    pair: `${r.mint}|${r.ticker}`,
    mint: r.mint,
    paidUsd: r.paidUsd / (siblings.get(r.signature) ?? 1),
    at: r.at,
  }));
}

/**
 * The holders' or the creator's share of the fees in a group of fills, as a SQL sum.
 *
 * The rewards page uses the same sums as the epoch, so what it shows is what the next epoch pays.
 * The share goes over the wire as a bound parameter, which Postgres types as text, so it is cast.
 * Without it every draft died on "operator does not exist: double precision * text".
 */
export function feeShareSql(side: "holders" | "creator") {
  const { fills } = schema;
  return sql<number>`coalesce(sum(${fills.feeUsd}), 0) * ${CASHBACK_SPLIT[side]}::float8`;
}

export interface HolderPool {
  mint: string;
  symbol: string | null;
  /** Everything ever owed to this token's holders, up to the cutoff. */
  accruedUsd: number;
  /** What published epochs have already shared out. */
  distributedUsd: number;
  /** The difference: what the next snapshot shares out. */
  waitingUsd: number;
  /** Distinct wallets paid from this pool across published epochs. */
  holdersPaid: number;
}

/** Every token's holder pool as of a cutoff, read from the database. */
export async function holderPools(asOf: Date): Promise<HolderPool[]> {
  const conn = requireDb();
  const { fills, listings, holderRewards, epochs } = schema;

  const [fees, listingRows, distributed] = await Promise.all([
    conn
      .select({
        mint: fills.mint,
        symbol: sql<string | null>`max(${fills.symbol})`,
        usd: feeShareSql("holders"),
      })
      .from(fills)
      .where(lte(fills.createdAt, asOf))
      .groupBy(fills.mint),
    conn
      .select({
        mint: listings.mint,
        ticker: listings.ticker,
        signature: listings.signature,
        paidUsd: listings.paidUsd,
        at: listings.createdAt,
      })
      .from(listings)
      .where(lte(listings.createdAt, asOf)),
    conn
      .select({
        mint: holderRewards.mint,
        usd: sql<number>`coalesce(sum(${holderRewards.amountUsd}), 0)`,
        holders: sql<number>`count(distinct ${holderRewards.wallet})`,
      })
      .from(holderRewards)
      .innerJoin(epochs, eq(holderRewards.epoch, epochs.index))
      .where(eq(epochs.status, "published"))
      .groupBy(holderRewards.mint),
  ]);

  const pools = new Map<string, HolderPool>();
  const pool = (mint: string) => {
    let p = pools.get(mint);
    if (!p) {
      p = { mint, symbol: null, accruedUsd: 0, distributedUsd: 0, waitingUsd: 0, holdersPaid: 0 };
      pools.set(mint, p);
    }
    return p;
  };

  for (const f of fees) {
    const p = pool(f.mint);
    p.accruedUsd += Number(f.usd ?? 0);
    p.symbol = f.symbol ?? p.symbol;
  }
  for (const l of listingsPerPair(listingRows)) pool(l.mint).accruedUsd += l.paidUsd;
  for (const d of distributed) {
    const p = pool(d.mint);
    p.distributedUsd = Number(d.usd ?? 0);
    p.holdersPaid = Number(d.holders ?? 0);
  }
  for (const p of pools.values()) p.waitingUsd = Math.max(0, p.accruedUsd - p.distributedUsd);

  return [...pools.values()].sort((a, b) => b.accruedUsd - a.accruedUsd);
}

/** What each wallet has been given by published epochs, summed over every token. */
async function publishedHolderUsd(): Promise<Map<string, number>> {
  const conn = requireDb();
  const { holderRewards, epochs } = schema;
  const rows = await conn
    .select({
      wallet: holderRewards.wallet,
      usd: sql<number>`coalesce(sum(${holderRewards.amountUsd}), 0)`,
    })
    .from(holderRewards)
    .innerJoin(epochs, eq(holderRewards.epoch, epochs.index))
    .where(eq(epochs.status, "published"))
    .groupBy(holderRewards.wallet);
  return new Map(rows.map((r) => [r.wallet, Number(r.usd ?? 0)]));
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
 * One token's holder weights over an epoch window: every sample's balance, summed per wallet.
 *
 * A wallet absent from a sample held nothing then and adds nothing for it, so a wallet that held for
 * a tenth of the samples weighs a tenth of one that held throughout. `current` is the snapshot taken
 * as the epoch is built, counted as one more sample. `samples` is how many went in, which turns a
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

/** Where the open window starts: the cutoff of the latest published epoch before `asOf`. */
async function windowStart(asOf: Date): Promise<Date> {
  const conn = requireDb();
  const { epochs } = schema;
  const [last] = await conn
    .select({ asOf: epochs.asOf })
    .from(epochs)
    .where(and(eq(epochs.status, "published"), lte(epochs.asOf, asOf)))
    .orderBy(desc(epochs.asOf))
    .limit(1);
  return last?.asOf ?? new Date(0);
}

/**
 * When the open epoch becomes due for automatic publishing: a full `AUTO_EPOCH_EVERY_MS` after the
 * first real holder sample since the last published epoch. Null while no token has been sampled,
 * which means nothing has accrued that a holder could be paid from.
 */
export async function autoEpochDueAt(now = new Date()): Promise<Date | null> {
  const conn = requireDb();
  const { holderSamples } = schema;
  const from = await windowStart(now);
  const [first] = await conn
    .select({ at: sql<Date | null>`min(${holderSamples.takenAt})` })
    .from(holderSamples)
    .where(and(sql`${holderSamples.mint} <> ''`, gt(holderSamples.takenAt, from)));
  return first?.at ? new Date(new Date(first.at).getTime() + AUTO_EPOCH_EVERY_MS) : null;
}

/** Every sample row for these mints inside (from, to], grouped by mint. */
async function samplesIn(mints: readonly string[], from: Date, to: Date) {
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
 * Called on a schedule by the sampler Worker. A token with nothing waiting is not sampled, because
 * nothing would be paid from it; if a pool fills later, the samples from then on are what count.
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

  const waiting = (await holderPools(now)).filter((p) => p.waitingUsd > 0);
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

export interface HolderEstimate {
  mint: string;
  symbol: string | null;
  waitingUsd: number;
  /** This wallet's part of the token's summed weight so far, 0 to 1. */
  share: number;
  estimatedUsd: number;
  samples: number;
}

/**
 * What a wallet would get from each waiting pool if the epoch were built from the samples so far.
 *
 * An estimate and labelled as one: the epoch adds a snapshot of its own, and whoever holds between
 * now and then changes the weights. It reads only the database, so it costs nothing to show on
 * every page view.
 */
export async function holderEstimates(wallet: string, asOf = new Date()): Promise<HolderEstimate[]> {
  const waiting = (await holderPools(asOf)).filter((p) => p.waitingUsd > 0);
  const samples = await samplesIn(
    waiting.map((p) => p.mint),
    await windowStart(asOf),
    asOf,
  );

  const out: HolderEstimate[] = [];
  for (const pool of waiting) {
    const { weights, samples: count } = holderWeightsFrom(samples.get(pool.mint) ?? [], null);
    const mine = weights.get(wallet);
    if (!mine) continue;
    let total = 0n;
    for (const w of weights.values()) total += w;
    const share = Number((mine * 1_000_000n) / total) / 1_000_000;
    out.push({
      mint: pool.mint,
      symbol: pool.symbol,
      waitingUsd: pool.waitingUsd,
      share,
      estimatedUsd: pool.waitingUsd * share,
      samples: count,
    });
  }
  return out.sort((a, b) => b.estimatedUsd - a.estimatedUsd);
}

/**
 * Every wallet's uncommitted balance as of a cutoff, and the holder allocations behind it.
 *
 * The holder half weighs every wallet by its balance across all the samples taken in this epoch's
 * window, plus a snapshot taken now, for each token whose pool has something waiting. What it
 * allocates is returned alongside the lines so the draft can store it: once the epoch is published
 * those rows are what the pool has paid out, and the next epoch shares out only what is left.
 *
 * The creator half and the committed subtraction are sums over append-only tables up to the cutoff,
 * as before.
 */
export async function computeEntitlements(
  asOf: Date,
  cookPriceUsd: number,
): Promise<{
  lines: EntitlementLine[];
  allocations: HolderAllocation[];
  /** The most samples any token's split was built from, the snapshot taken now included. */
  holderSamples: number;
}> {
  const conn = requireDb();
  const { fills, claims, epochs } = schema;

  const [pools, given, asCreator, committed] = await Promise.all([
    holderPools(asOf),
    publishedHolderUsd(),
    conn
      .select({ wallet: fills.creator, feeUsd: feeShareSql("creator") })
      .from(fills)
      .where(and(isNotNull(fills.creator), lte(fills.createdAt, asOf)))
      .groupBy(fills.creator),
    conn
      .select({ wallet: claims.wallet, amountUsd: sql<number>`sum(${claims.amountUsd})` })
      .from(claims)
      .innerJoin(epochs, eq(claims.epoch, epochs.index))
      .where(
        and(
          eq(epochs.status, "published"),
          // Claimed is spent. Still inside its window is promised. Either way it is not free.
          or(
            isNotNull(claims.signature),
            isNotNull(claims.claimedAt),
            gt(epochs.deadline, new Date()),
          ),
        ),
      )
      .groupBy(claims.wallet),
  ]);

  const waiting = pools.filter((p) => p.waitingUsd > 0);
  const mints = waiting.map((p) => p.mint);
  const [snapshots, sampled] = await Promise.all([
    snapshotHolders(mints),
    windowStart(asOf).then((from) => samplesIn(mints, from, asOf)),
  ]);

  const weights = new Map<string, Map<string, bigint>>();
  const counts = new Map<string, number>();
  for (const snap of snapshots) {
    const w = holderWeightsFrom(sampled.get(snap.mint) ?? [], snap.holders);
    weights.set(snap.mint, w.weights);
    counts.set(snap.mint, w.samples);
  }

  const allocations = holderAllocationsFrom({
    waitingByMint: new Map(waiting.map((p) => [p.mint, p.waitingUsd])),
    holders: weights,
  }).map((a) => ({
    ...a,
    // Stored as the average balance across the samples, which is what a reader expects to see.
    balanceRaw: a.balanceRaw / BigInt(Math.max(1, counts.get(a.mint) ?? 1)),
  }));

  const holderUsd = new Map(given);
  for (const a of allocations) {
    holderUsd.set(a.wallet, (holderUsd.get(a.wallet) ?? 0) + a.amountUsd);
  }

  const numbers = (rows: { wallet: string | null; value: unknown }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.wallet) m.set(r.wallet, Number(r.value ?? 0));
    return m;
  };

  const lines = entitlementsFrom({
    holderUsd,
    creatorUsd: numbers(asCreator.map((r) => ({ wallet: r.wallet, value: r.feeUsd }))),
    committedUsd: numbers(committed.map((r) => ({ wallet: r.wallet, value: r.amountUsd }))),
    cookPriceUsd,
  });
  return { lines, allocations, holderSamples: Math.max(0, ...counts.values()) };
}

// --- epochs ------------------------------------------------------------------------------------

export interface EpochRow {
  index: string;
  root: string;
  totalRaw: string;
  totalCook: number;
  totalUsd: number;
  claimants: number;
  cookPriceUsd: number;
  asOf: string;
  deadline: string;
  status: string;
  signature: string | null;
  publishedAt: string | null;
  /** What the chain says about this epoch, when it is there to say anything. */
  onChain: {
    claimedCook: number;
    claimedCount: number;
    closed: boolean;
    expired: boolean;
  } | null;
}

type StoredEpoch = typeof schema.epochs.$inferSelect;

function rowOf(e: StoredEpoch): EpochRow {
  return {
    index: e.index.toString(),
    root: e.root,
    totalRaw: e.totalRaw.toString(),
    totalCook: toCook(e.totalRaw),
    totalUsd: e.totalUsd,
    claimants: e.claimants,
    cookPriceUsd: e.cookPriceUsd,
    asOf: e.asOf.toISOString(),
    deadline: e.deadline.toISOString(),
    status: e.status,
    signature: e.signature,
    publishedAt: e.publishedAt?.toISOString() ?? null,
    onChain: null,
  };
}

function shortfall(total: bigint, snapshot: VaultSnapshot): bigint {
  return total > snapshot.free ? total - snapshot.free : 0n;
}

export interface DraftResult {
  epoch: EpochRow;
  lines: EntitlementLine[];
  /** COOK the vault holds free of earlier epochs. The program refuses a root it cannot back. */
  freeRaw: string;
  freeCook: number;
  /** How much more the vault needs before this epoch can be published. Zero when it is ready. */
  shortfallRaw: string;
  shortfallCook: number;
  /** True when an existing draft was returned untouched. */
  reused: boolean;
  /** How many holder samples the split was built from. Unknown on a reused draft. */
  holderSamples: number | null;
}

/**
 * Build the next epoch, or return the draft that is already waiting.
 *
 * Idempotent on purpose. A draft moves no money, but replacing one the authority has already
 * signed against would orphan that signature, so a second call returns what is there unless the
 * caller explicitly asks to rebuild. A rebuild takes a fresh holder snapshot and can land on a
 * different root, which is why the endpoint in front of this only lets the vault authority call it.
 */
export async function buildDraft(opts: { rebuild?: boolean } = {}): Promise<DraftResult> {
  const conn = requireDb();
  const { epochs, claims, holderRewards } = schema;

  const snapshot = await fetchVault(cookieConnection(), MINT);
  if (!snapshot) {
    throw new EpochError(
      "there is no vault on this chain yet - deploy the program and initialize it first",
      412,
    );
  }
  // The program insists the index equals the vault's own epoch count, so the chain owns the
  // sequence and a draft built against a stale count would simply be refused on publish.
  const index = snapshot.state.epochCount;

  const existing = await conn.select().from(epochs).where(eq(epochs.index, index)).limit(1);
  if (existing[0]?.status === "published") {
    throw new EpochError(`epoch ${index} is already published`, 409);
  }
  if (existing[0] && !opts.rebuild) {
    return {
      epoch: rowOf(existing[0]),
      lines: await storedLines(index),
      freeRaw: snapshot.free.toString(),
      freeCook: toCook(snapshot.free),
      shortfallRaw: shortfall(existing[0].totalRaw, snapshot).toString(),
      shortfallCook: toCook(shortfall(existing[0].totalRaw, snapshot)),
      reused: true,
      holderSamples: null,
    };
  }

  const cookPriceUsd = await fetchCookPriceUsd();
  if (!cookPriceUsd) {
    throw new EpochError("no COOK price available, so USD balances cannot be converted", 503);
  }

  const asOf = new Date();
  const { lines, allocations, holderSamples } = await computeEntitlements(asOf, cookPriceUsd);
  if (lines.length === 0) {
    throw new EpochError("nothing is owed above the claim floor yet", 409);
  }

  const entitlements: Entitlement[] = lines.map((l) => ({ wallet: l.wallet, amount: l.amountRaw }));
  const tree = buildEpochTree(entitlements, index);
  const deadline = new Date(asOf.getTime() + CASHBACK_CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const row: StoredEpoch = {
    index,
    root: hex(tree.root),
    totalRaw: tree.total,
    totalUsd: lines.reduce((sum, l) => sum + l.amountUsd, 0),
    claimants: lines.length,
    cookPriceUsd,
    asOf,
    deadline,
    status: "draft",
    signature: null,
    createdAt: new Date(),
    publishedAt: null,
  };

  await conn.transaction(async (tx) => {
    await tx.delete(claims).where(eq(claims.epoch, index));
    await tx.delete(holderRewards).where(eq(holderRewards.epoch, index));
    await tx.delete(epochs).where(eq(epochs.index, index));
    await tx.insert(epochs).values(row);
    await tx.insert(claims).values(
      lines.map((l) => ({
        epoch: index,
        wallet: l.wallet,
        amountRaw: l.amountRaw,
        amountUsd: l.amountUsd,
        holderUsd: l.holderUsd,
        creatorUsd: l.creatorUsd,
      })),
    );
    // Stored with the lines, because the snapshot behind them cannot be taken again later.
    for (let i = 0; i < allocations.length; i += 500) {
      await tx.insert(holderRewards).values(
        allocations.slice(i, i + 500).map((a) => ({
          epoch: index,
          mint: a.mint,
          wallet: a.wallet,
          balanceRaw: a.balanceRaw,
          amountUsd: a.amountUsd,
        })),
      );
    }
  });

  return {
    epoch: rowOf(row),
    lines,
    freeRaw: snapshot.free.toString(),
    freeCook: toCook(snapshot.free),
    shortfallRaw: shortfall(tree.total, snapshot).toString(),
    shortfallCook: toCook(shortfall(tree.total, snapshot)),
    reused: false,
    holderSamples,
  };
}

async function storedLines(index: bigint): Promise<EntitlementLine[]> {
  const conn = requireDb();
  const rows = await conn
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.epoch, index))
    .orderBy(desc(schema.claims.amountUsd));
  return rows.map((r) => ({
    wallet: r.wallet,
    holderUsd: r.holderUsd,
    creatorUsd: r.creatorUsd,
    amountUsd: r.amountUsd,
    amountRaw: r.amountRaw,
  }));
}

/** sha256("global:publish_epoch")[0..8], the same eight bytes `vault.ts` sends. */
const PUBLISH_DISCRIMINATOR = Uint8Array.from([222, 6, 136, 82, 54, 246, 245, 120]);

/**
 * Pull the epoch index and root out of the transaction that published them.
 *
 * Reading the instruction rather than believing the caller is what lets the publish endpoint take
 * a bare signature and nothing else. Null means the transaction was not a publish, whatever it
 * was sent as.
 */
function decodePublish(tx: VersionedTransactionResponse): { index: bigint; root: string } | null {
  const message = tx.transaction.message;

  let keys;
  try {
    keys = message.getAccountKeys();
  } catch {
    // A message that loads its addresses from a lookup table cannot be read without them, and the
    // publish transaction Coorwa builds never uses one.
    return null;
  }

  for (const ix of message.compiledInstructions) {
    if (!keys.get(ix.programIdIndex)?.equals(VAULT_PROGRAM_ID)) continue;

    const data = Uint8Array.from(ix.data);
    // discriminator, then a u64 index, then the 32 byte root.
    if (data.length < 48) continue;
    if (PUBLISH_DISCRIMINATOR.some((b, i) => data[i] !== b)) continue;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { index: view.getBigUint64(8, true), root: hex(data.subarray(16, 48)) };
  }
  return null;
}

/**
 * Promote a draft to published, on the strength of the transaction that did it.
 *
 * Nothing here trusts the caller. The signature is read back from the chain, the publish
 * instruction is decoded out of it, and the root it carries is compared with the draft's. A
 * mismatch means the draft was rebuilt after the authority signed, and it is refused rather than
 * papered over: an epoch whose leaves Coorwa cannot reproduce is an epoch nobody can claim.
 */
export async function publishFromChain(signature: string): Promise<EpochRow> {
  const conn = requireDb();
  const { epochs } = schema;
  const connection = cookieConnection();

  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) throw new EpochError("that transaction is not on chain", 404);
  if (tx.meta?.err) throw new EpochError("that transaction failed on chain", 409);

  const published = decodePublish(tx);
  if (!published) throw new EpochError("that transaction does not publish a cashback epoch", 400);

  const stored = await conn.select().from(epochs).where(eq(epochs.index, published.index)).limit(1);
  const draft = stored[0];
  if (!draft) {
    throw new EpochError(
      `epoch ${published.index} is live on chain but Coorwa holds no leaves for it, so no proof can be produced`,
      409,
    );
  }
  if (draft.root !== published.root) {
    throw new EpochError(
      `the published root ${published.root.slice(0, 12)} does not match the draft ${draft.root.slice(0, 12)}`,
      409,
    );
  }

  // The account is the record, not the instruction: reading it back proves the program accepted it.
  const [onChain] = await fetchEpochs(connection, MINT, [published.index]);
  if (!onChain || hex(onChain.root) !== draft.root) {
    throw new EpochError("the epoch account does not carry that root", 409);
  }

  const [updated] = await conn
    .update(epochs)
    .set({
      status: "published",
      signature,
      publishedAt: onChain.publishedAt,
      deadline: onChain.deadline,
    })
    .where(eq(epochs.index, published.index))
    .returning();

  return rowOf(updated);
}

// --- what a wallet can claim right now -----------------------------------------------------------

export interface ClaimableLine {
  epoch: string;
  root: string;
  amountRaw: string;
  amountCook: number;
  amountUsd: number;
  holderUsd: number;
  creatorUsd: number;
  deadline: string;
  /** Sibling hashes, leaf upwards, as hex. The browser passes them straight to the program. */
  proof: string[];
  claimed: boolean;
  claimedAt: string | null;
  signature: string | null;
  /** False when the epoch is closed or its window has passed, which is why it cannot be claimed. */
  claimable: boolean;
}

export interface VaultView {
  address: string;
  authority: string;
  balanceCook: number;
  reservedCook: number;
  freeCook: number;
  epochCount: string;
}

export interface ClaimableReport {
  configured: boolean;
  deployed: boolean;
  vault: VaultView | null;
  lines: ClaimableLine[];
  claimableCook: number;
}

function vaultView(snapshot: VaultSnapshot): VaultView {
  return {
    address: snapshot.state.address.toBase58(),
    authority: snapshot.state.authority.toBase58(),
    balanceCook: toCook(snapshot.balance),
    reservedCook: toCook(snapshot.state.reserved),
    freeCook: toCook(snapshot.free),
    epochCount: snapshot.state.epochCount.toString(),
  };
}

/**
 * Everything the rewards page needs to decide what the Claim button should say.
 *
 * The claim records on chain are the authority on what has been claimed, not this database, so
 * they are read every time and written back when the two disagree. That happens for real: a claim
 * can confirm while the report to the API is still in flight.
 */
export async function claimableFor(wallet: string | null): Promise<ClaimableReport> {
  const connection = cookieConnection();
  const base: ClaimableReport = {
    configured: dbEnabled,
    deployed: false,
    vault: null,
    lines: [],
    claimableCook: 0,
  };

  if (!(await isVaultDeployed(connection))) return base;
  base.deployed = true;

  const snapshot = await fetchVault(connection, MINT);
  base.vault = snapshot ? vaultView(snapshot) : null;

  if (!dbEnabled || !db || !wallet) return base;

  const { claims, epochs } = schema;
  const rows = await db
    .select({ claim: claims, epoch: epochs })
    .from(claims)
    .innerJoin(epochs, eq(claims.epoch, epochs.index))
    .where(and(eq(claims.wallet, wallet), eq(epochs.status, "published")))
    .orderBy(asc(claims.epoch));

  if (rows.length === 0) return base;

  const indices = rows.map((r) => r.claim.epoch);
  const claimant = new PublicKey(wallet);
  const [onChainEpochs, statuses, trees] = await Promise.all([
    fetchEpochs(connection, MINT, indices),
    fetchClaimStatuses(connection, MINT, indices, claimant),
    Promise.all(indices.map((i) => treeFor(i))),
  ]);

  const now = Date.now();
  const heal: { id: number; claimedAt: Date }[] = [];

  const lines = rows.map((r, i) => {
    const status = statuses[i];
    const chain = onChainEpochs[i];
    const claimed = Boolean(status) || r.claim.claimedAt !== null;
    if (status && !r.claim.claimedAt) heal.push({ id: r.claim.id, claimedAt: status.claimedAt });

    const deadline = chain?.deadline ?? r.epoch.deadline;

    return {
      epoch: r.claim.epoch.toString(),
      root: r.epoch.root,
      amountRaw: r.claim.amountRaw.toString(),
      amountCook: toCook(r.claim.amountRaw),
      amountUsd: r.claim.amountUsd,
      holderUsd: r.claim.holderUsd,
      creatorUsd: r.claim.creatorUsd,
      deadline: deadline.toISOString(),
      proof: trees[i].proofFor(wallet).map(hex),
      claimed,
      claimedAt: (r.claim.claimedAt ?? status?.claimedAt)?.toISOString() ?? null,
      signature: r.claim.signature,
      claimable: !claimed && !(chain?.closed ?? false) && deadline.getTime() > now,
    } satisfies ClaimableLine;
  });

  // Catching up on a claim the chain already knows about. Nothing depends on it landing, so a
  // failure here must not cost the caller their answer.
  if (heal.length > 0) {
    await Promise.all(
      heal.map((h) =>
        db!.update(claims).set({ claimedAt: h.claimedAt }).where(eq(claims.id, h.id)),
      ),
    ).catch(() => undefined);
  }

  base.lines = lines;
  base.claimableCook = lines.filter((l) => l.claimable).reduce((s, l) => s + l.amountCook, 0);
  return base;
}

/**
 * Rebuild one epoch's tree from its stored leaves.
 *
 * The leaves are the record and the tree is derived, which is why no proof is ever stored: the
 * tree sorts by leaf hash, so the rebuild is identical every time regardless of row order, and a
 * proof produced today is the one that was produced the day the epoch was published.
 */
export async function treeFor(index: bigint) {
  const conn = requireDb();
  const rows = await conn.select().from(schema.claims).where(eq(schema.claims.epoch, index));
  if (rows.length === 0) throw new EpochError(`no leaves are stored for epoch ${index}`, 404);
  return buildEpochTree(
    rows.map((r) => ({ wallet: r.wallet, amount: r.amountRaw })),
    index,
  );
}

// --- recording a claim ---------------------------------------------------------------------------

/**
 * Record a claim that has already happened.
 *
 * This adds nothing the chain does not already know - `claimableFor` recovers the same fact from
 * the claim record if this never runs - but it captures the signature, which the claim record does
 * not hold, so a claimant keeps a link to their own transaction.
 */
export async function recordClaim(args: {
  signature: string;
  wallet: string;
  epoch: bigint;
}): Promise<{ recorded: boolean }> {
  const conn = requireDb();
  const connection = cookieConnection();

  const tx = await connection.getTransaction(args.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) throw new EpochError("that transaction is not on chain", 404);
  if (tx.meta?.err) throw new EpochError("that transaction failed on chain", 409);

  const signer = tx.transaction.message.getAccountKeys().get(0)?.toBase58();
  if (signer !== args.wallet) {
    throw new EpochError("that transaction was not signed by this wallet", 403);
  }

  // The program's own claim record is what makes this true. Without it the transaction did
  // something else, whatever it was reported as.
  const [status] = await fetchClaimStatuses(
    connection,
    MINT,
    [args.epoch],
    new PublicKey(args.wallet),
  );
  if (!status) throw new EpochError("no claim was recorded on chain for that epoch", 409);

  const { claims } = schema;
  await conn
    .update(claims)
    .set({ signature: args.signature, claimedAt: status.claimedAt })
    .where(and(eq(claims.epoch, args.epoch), eq(claims.wallet, args.wallet)));

  return { recorded: true };
}

// --- the operator's view -------------------------------------------------------------------------

export interface EpochOverview {
  configured: boolean;
  deployed: boolean;
  vault: VaultView | null;
  epochs: EpochRow[];
  /** Epochs whose window has passed and whose reserve anyone may return to the vault. */
  closable: string[];
  /** The server key that publishes epochs on its own, when this deployment has one. */
  publisher: { address: string; cook: number; dueAt: string | null } | null;
}

export async function overview(): Promise<EpochOverview> {
  const connection = cookieConnection();
  const deployed = await isVaultDeployed(connection);
  const snapshot = deployed ? await fetchVault(connection, MINT) : null;
  const vault = snapshot ? vaultView(snapshot) : null;

  const key = publisherKeypair();
  const publisherBase = key
    ? {
        address: key.publicKey.toBase58(),
        cook: toCook(BigInt(await connection.getBalance(key.publicKey))),
      }
    : null;

  if (!dbEnabled || !db) {
    const publisher = publisherBase ? { ...publisherBase, dueAt: null } : null;
    return { configured: false, deployed, vault, epochs: [], closable: [], publisher };
  }

  const stored = await db.select().from(schema.epochs).orderBy(desc(schema.epochs.index)).limit(24);
  const chain = deployed
    ? await fetchEpochs(
        connection,
        MINT,
        stored.map((e) => e.index),
      )
    : [];

  const now = Date.now();
  const closable: string[] = [];
  const epochs = stored.map((e, i) => {
    const row = rowOf(e);
    const c = chain[i];
    if (c) {
      const expired = c.deadline.getTime() <= now;
      row.onChain = {
        claimedCook: toCook(c.claimed),
        claimedCount: c.claimedCount,
        closed: c.closed,
        expired,
      };
      if (expired && !c.closed) closable.push(e.index.toString());
    }
    return row;
  });

  const dueAt = publisherBase ? await autoEpochDueAt() : null;
  const publisher = publisherBase
    ? { ...publisherBase, dueAt: dueAt?.toISOString() ?? null }
    : null;

  return { configured: true, deployed, vault, epochs, closable, publisher };
}

/**
 * Every proof in a set verifies against its own root.
 *
 * Cheap, and it runs before a draft is offered for signing. A tree that cannot open its own leaves
 * would be discovered by the first claimant, on chain, after the money was already reserved.
 */
export function checkTree(index: bigint, lines: EntitlementLine[]): void {
  const tree = buildEpochTree(
    lines.map((l) => ({ wallet: l.wallet, amount: l.amountRaw })),
    index,
  );
  for (const l of lines) {
    if (!verifyProof(tree.root, index, l.wallet, l.amountRaw, tree.proofFor(l.wallet))) {
      throw new Error(`the proof for ${l.wallet} does not verify against its own root`);
    }
  }
}
