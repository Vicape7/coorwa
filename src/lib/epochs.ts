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
import { and, asc, desc, eq, gt, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { db, dbEnabled, schema } from "./db";
import { buildEpochTree, verifyProof, type Entitlement } from "./merkle";
import { fetchCookPriceUsd } from "./cookiescan";
import {
  CASHBACK_CLAIM_WINDOW_DAYS,
  CASHBACK_MIN_CLAIM_COOK,
  CASHBACK_SPLIT,
  SWAP_CASHBACK_SPLIT,
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
  traderUsd: number;
  creatorUsd: number;
  amountUsd: number;
  amountRaw: bigint;
}

export interface Accrual {
  /**
   * The trader's share of the fees the wallet generated, **after** its split.
   *
   * Split at the source rather than here, because the two sources do not share one. A launchpad
   * referral is somebody else's money and holds a fifth back for liquidity; a swap fee comes out of
   * the trader's own pocket, so all of it goes back and keeping any would make Coorwa a toll.
   */
  traderUsd: Map<string, number>;
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
  const { traderUsd: traderShare, creatorUsd: creatorShare, committedUsd, cookPriceUsd } = accrual;
  if (!(cookPriceUsd > 0)) throw new Error("a COOK price is needed to convert a USD balance");

  const wallets = new Set([...traderShare.keys(), ...creatorShare.keys()]);
  const out: EntitlementLine[] = [];

  for (const wallet of wallets) {
    const traderUsd = traderShare.get(wallet) ?? 0;
    const creatorUsd = creatorShare.get(wallet) ?? 0;
    const amountUsd = traderUsd + creatorUsd - (committedUsd.get(wallet) ?? 0);
    if (!(amountUsd > 0)) continue;

    const raw = BigInt(Math.floor((amountUsd / cookPriceUsd) * Number(UNITS_PER_COOK)));
    // Under the floor a claim costs the claimant more in rent than it pays them. The balance is
    // not dropped: it stays uncommitted and rolls into whichever epoch it finally clears.
    if (raw < MIN_CLAIM_RAW) continue;

    out.push({ wallet, traderUsd, creatorUsd, amountUsd, amountRaw: raw });
  }

  return out.sort((a, b) => b.amountUsd - a.amountUsd);
}

// --- listing fees --------------------------------------------------------------------------------

/** Fees one wallet paid trading one pair, identified as `mint|TICKER`. */
export interface PairFill {
  pair: string;
  wallet: string;
  feeUsd: number;
  at: Date;
}

/** A listing fee paid for one pair. */
export interface PairListing {
  pair: string;
  paidUsd: number;
  at: Date;
}

/**
 * What each wallet has earned from listing fees, cumulatively, up to the last boundary.
 *
 * A listing fee belongs to the pair it bought and goes to the people trading that pair. Each epoch
 * is a window, from the cutoff of the published epoch before it to its own. A pair's listing money
 * that arrived by the end of a window is shared out over the wallets that traded the pair inside
 * it, in proportion to the Coorwa fee each paid there. The fee rather than a reported trade size,
 * because the fee is read off the chain and a size is whatever a client says. A window in which
 * nobody traded the pair shares out nothing, and the money waits for the next one.
 *
 * All of it goes to traders, none to the creator: the creator is the one who paid it.
 *
 * Cumulative on purpose, like the fee accrual beside it. The windows of published epochs never
 * move, so what a wallet was given in them never shrinks, and `entitlementsFrom` can take what has
 * already been committed straight back off. A share worked out over all time instead would fall
 * for an early trader whenever somebody else traded later, and the epoch that had already paid them
 * would then have paid out more than the pair ever brought in.
 *
 * `boundaries` are the cutoffs, oldest first; the last is the epoch being built. Anything after it
 * belongs to a later epoch and is ignored.
 */
export function listingSharesFrom(args: {
  fills: readonly PairFill[];
  listings: readonly PairListing[];
  boundaries: readonly Date[];
}): Map<string, number> {
  const out = new Map<string, number>();
  const pairs = new Set([...args.listings.map((l) => l.pair)]);

  for (const pair of pairs) {
    let pool = 0;
    let from = -Infinity;
    for (const boundary of args.boundaries) {
      const to = boundary.getTime();
      const inWindow = (at: Date) => at.getTime() > from && at.getTime() <= to;

      for (const l of args.listings) {
        if (l.pair === pair && inWindow(l.at)) pool += l.paidUsd;
      }

      const paid = new Map<string, number>();
      let total = 0;
      for (const f of args.fills) {
        if (f.pair !== pair || !(f.feeUsd > 0) || !inWindow(f.at)) continue;
        paid.set(f.wallet, (paid.get(f.wallet) ?? 0) + f.feeUsd);
        total += f.feeUsd;
      }

      if (pool > 0 && total > 0) {
        for (const [wallet, fee] of paid) {
          out.set(wallet, (out.get(wallet) ?? 0) + (pool * fee) / total);
        }
        pool = 0;
      }
      from = to;
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
): PairListing[] {
  const siblings = new Map<string, number>();
  for (const r of rows) siblings.set(r.signature, (siblings.get(r.signature) ?? 0) + 1);
  return rows.map((r) => ({
    pair: `${r.mint}|${r.ticker}`,
    paidUsd: r.paidUsd / (siblings.get(r.signature) ?? 1),
    at: r.at,
  }));
}

/** Every wallet's listing-fee share as of a cutoff, read from the database. */
export async function listingAccrual(asOf: Date): Promise<Map<string, number>> {
  const conn = requireDb();
  const { fills, listings, epochs } = schema;

  const [pairFills, listingRows, published] = await Promise.all([
    conn
      .select({
        mint: fills.mint,
        ticker: fills.ticker,
        wallet: fills.wallet,
        feeUsd: fills.feeUsd,
        at: fills.createdAt,
      })
      .from(fills)
      .where(and(isNotNull(fills.ticker), gt(fills.feeUsd, 0), lte(fills.createdAt, asOf))),
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
      .select({ asOf: epochs.asOf })
      .from(epochs)
      .where(and(eq(epochs.status, "published"), lt(epochs.asOf, asOf)))
      .orderBy(asc(epochs.asOf)),
  ]);

  return listingSharesFrom({
    fills: pairFills.map((f) => ({
      pair: `${f.mint}|${f.ticker}`,
      wallet: f.wallet,
      feeUsd: f.feeUsd,
      at: f.at,
    })),
    listings: listingsPerPair(listingRows),
    boundaries: [...published.map((e) => e.asOf), asOf],
  });
}

/**
 * Every wallet's uncommitted balance as of a cutoff.
 *
 * Four sums and a subtraction: the trader's share of the fees they generated, their share of the
 * listing fees of the pairs they traded, the creator's share of the fees earned on tokens they
 * launched, and everything already committed to an epoch taken back off. The cutoff is what makes this reproducible - `fills` is append-only, so the same cutoff
 * always returns the same set, which is why rebuilding a draft lands on the same root.
 */
export async function computeEntitlements(
  asOf: Date,
  cookPriceUsd: number,
): Promise<EntitlementLine[]> {
  const conn = requireDb();
  const { fills, claims, epochs } = schema;

  // The split is applied here, in the sum, because it belongs to where the fee came from. A
  // launchpad referral holds a fifth back for liquidity; a swap fee is returned whole.
  // The shares go over the wire as bound parameters, which Postgres types as text, so they are cast.
  // Without it every draft died on "operator does not exist: double precision * text".
  const traderShare = sql<number>`sum(${fills.feeUsd} * case when ${fills.source} = 'launchpad'
    then ${CASHBACK_SPLIT.trader}::float8 else ${SWAP_CASHBACK_SPLIT.trader}::float8 end)`;
  const creatorShare = sql<number>`sum(${fills.feeUsd} * case when ${fills.source} = 'launchpad'
    then ${CASHBACK_SPLIT.creator}::float8 else ${SWAP_CASHBACK_SPLIT.creator}::float8 end)`;

  const [asTrader, asCreator, committed, listingShare] = await Promise.all([
    conn
      .select({ wallet: fills.wallet, feeUsd: traderShare })
      .from(fills)
      .where(lte(fills.createdAt, asOf))
      .groupBy(fills.wallet),
    conn
      .select({ wallet: fills.creator, feeUsd: creatorShare })
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
    listingAccrual(asOf),
  ]);

  const numbers = (rows: { wallet: string | null; value: unknown }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.wallet) m.set(r.wallet, Number(r.value ?? 0));
    return m;
  };

  // A pair's listing fees are the traders' cashback, so they join the trader's half of the line.
  const traderUsd = numbers(asTrader.map((r) => ({ wallet: r.wallet, value: r.feeUsd })));
  for (const [wallet, usd] of listingShare) {
    traderUsd.set(wallet, (traderUsd.get(wallet) ?? 0) + usd);
  }

  return entitlementsFrom({
    traderUsd,
    creatorUsd: numbers(asCreator.map((r) => ({ wallet: r.wallet, value: r.feeUsd }))),
    committedUsd: numbers(committed.map((r) => ({ wallet: r.wallet, value: r.amountUsd }))),
    cookPriceUsd,
  });
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
}

/**
 * Build the next epoch, or return the draft that is already waiting.
 *
 * Idempotent on purpose. A draft moves no money, but replacing one the authority has already
 * signed against would orphan that signature, so a second call returns what is there unless the
 * caller explicitly asks to rebuild. That is also why this needs no authentication: the worst a
 * stranger achieves by calling it is computing the same draft twice.
 */
export async function buildDraft(opts: { rebuild?: boolean } = {}): Promise<DraftResult> {
  const conn = requireDb();
  const { epochs, claims } = schema;

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
    };
  }

  const cookPriceUsd = await fetchCookPriceUsd();
  if (!cookPriceUsd) {
    throw new EpochError("no COOK price available, so USD balances cannot be converted", 503);
  }

  const asOf = new Date();
  const lines = await computeEntitlements(asOf, cookPriceUsd);
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
    await tx.delete(epochs).where(eq(epochs.index, index));
    await tx.insert(epochs).values(row);
    await tx.insert(claims).values(
      lines.map((l) => ({
        epoch: index,
        wallet: l.wallet,
        amountRaw: l.amountRaw,
        amountUsd: l.amountUsd,
        traderUsd: l.traderUsd,
        creatorUsd: l.creatorUsd,
      })),
    );
  });

  return {
    epoch: rowOf(row),
    lines,
    freeRaw: snapshot.free.toString(),
    freeCook: toCook(snapshot.free),
    shortfallRaw: shortfall(tree.total, snapshot).toString(),
    shortfallCook: toCook(shortfall(tree.total, snapshot)),
    reused: false,
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
    traderUsd: r.traderUsd,
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
  traderUsd: number;
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
      traderUsd: r.claim.traderUsd,
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
}

export async function overview(): Promise<EpochOverview> {
  const connection = cookieConnection();
  const deployed = await isVaultDeployed(connection);
  const snapshot = deployed ? await fetchVault(connection, MINT) : null;
  const vault = snapshot ? vaultView(snapshot) : null;

  if (!dbEnabled || !db) return { configured: false, deployed, vault, epochs: [], closable: [] };

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

  return { configured: true, deployed, vault, epochs, closable };
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
