/**
 * MomoSwap launchpad client - Cookie Chain's bonding-curve launchpad.
 *
 * Its API serves the pool reads and BUILDS every launchpad transaction: it leases a pre-ground
 * `momo`-suffixed mint (the program enforces that suffix on-chain), pins metadata to IPFS, and
 * returns an unsigned, partially-signed transaction. Coorwa simulates and the user's wallet signs,
 * so the flow stays non-custodial.
 *
 * Why Coorwa cares: the launchpad splits its 1% trade fee, and 20% of that goes to whoever is named
 * as referrer. With no referrer the programme keeps that share itself - so naming Coorwa costs the
 * trader nothing and is where the launchpad part of holder rewards comes from.
 */
import { MOMOSWAP_API, COORWA_REFERRER } from "./config";
import { fetchJson, cachedStale, CoorwaError } from "./http";
import { uiToRaw } from "./format";
import type { Expectation } from "./expectation";

const LP = `${MOMOSWAP_API}/v1/launchpad`;

export type PoolStatus = "upcoming" | "live" | "ended" | "graduated" | "expired";
export type ExpiryMode = "dead" | "fair" | "jackpot" | "survivor";

export interface LaunchpadConfig {
  paymentMint: string;
  /** Total trade fee, in basis points of the trade. */
  tradeFeeBps: number;
  /** The splits below are basis points OF THE FEE, not of the trade. */
  treasuryFeeBps: number;
  creatorFeeBps: number;
  referralFeeBps: number;
  buybackFeeBps: number;
  creationFeeLamports: string;
  graduationTarget: string;
  defaultTokenDecimals: number;
  defaultTotalSupply: string;
  defaultSaleSupply: string;
  creatorVestBps: number;
  paused: boolean;
  /** Pre-ground `momo` mints in reserve. Zero means launches are unavailable. */
  momoReady?: number;
}

export interface LaunchpadPool {
  pubkey: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  /** The image from the token's metadata, added by `/api/launchpad/pools`. */
  logo?: string | null;
  /** The token's pair asset, added by `/api/launchpad/pools`. Null until one is chosen. */
  ticker?: string | null;
  tokenMint: string;
  launchTs: number;
  endTs: number;
  expiryMode: ExpiryMode;
  state: string;
  status: PoolStatus;
  totalTokenSupply: string;
  saleTokenSupply: string;
  tokensSold: string;
  paymentRaisedNet: string;
  paymentRaisedGross: string;
  participantCount: string;
  graduationTarget: string;
  graduatedAt: number;
  /**
   * The curve's constants, fixed at creation - they do not move as people trade. Current reserves
   * are these plus what the pool has taken in and minus what it has sold, which is what
   * `src/lib/curve.ts` reconstructs to price a trade.
   */
  virtualPaymentReserve: string;
  virtualTokenReserve: string;
  totalActiveShares: string;
  /** Per-pool, and not always the same as the launchpad's current default. */
  tradeFeeBps: number;
  referralFeeBps: number;
  minBuy: string;
  maxBuyPerWallet: string;
}

/** One fill on a curve, as the launchpad's indexer reports it. Amounts are already in UI units. */
export interface LaunchpadTrade {
  ts: number;
  side: "buy" | "sell";
  trader: string;
  /** Payment per token, in COOK. */
  price: number;
  tokens: number;
  payment: number;
  sig: string;
}

export interface BuiltTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** create-pool only: the leased `momo` mint the token will be created at. */
  mint?: string;
  /** create-pool only: the pool the curve will live at, known before the launch is even signed. */
  pool?: string;
  /** What the launchpad says it built. `src/lib/expectation.ts` checks the bytes against it. */
  expectation?: Expectation;
}

type Envelope<T> = T & { success?: boolean; error?: string };

function unwrap<T>(res: Envelope<T>, what: string): T {
  if (res.success === false) {
    throw new CoorwaError(res.error ?? `${what} failed`, "check the inputs and retry");
  }
  return res;
}

async function get<T>(path: string, what: string): Promise<T> {
  return unwrap(await fetchJson<Envelope<T>>(`${LP}${path}`), what);
}

async function post<T>(path: string, body: unknown, what: string, timeoutMs = 30_000): Promise<T> {
  return unwrap(
    await fetchJson<Envelope<T>>(`${LP}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs,
    }),
    what,
  );
}

// --- Reads ---------------------------------------------------------------------------------------

export async function fetchConfig(): Promise<LaunchpadConfig> {
  return cachedStale("lp:config", 60_000, async () => {
    const { config } = await get<{ config: LaunchpadConfig }>("/config", "launchpad config");
    return config;
  });
}

export async function fetchPools(status: PoolStatus | "all" = "all"): Promise<LaunchpadPool[]> {
  return cachedStale(`lp:pools:${status}`, 15_000, async () => {
    const res = await get<{ pools?: LaunchpadPool[] }>(
      `/pools?status=${status}`,
      "launchpad pools",
    );
    return res.pools ?? [];
  });
}

export async function fetchPool(pool: string): Promise<LaunchpadPool> {
  const res = await get<{ pool: LaunchpadPool }>(`/pools/${pool}`, "launchpad pool");
  return res.pool;
}

export async function fetchPendingCreatorFees(pool: string): Promise<number> {
  const res = await get<{ pendingCook?: number }>(`/creator-fees/${pool}`, "pending creator fees");
  return res.pendingCook ?? 0;
}

export async function fetchPoolTrades(pool: string): Promise<LaunchpadTrade[]> {
  return cachedStale(`lp:trades:${pool}`, 10_000, async () => {
    const res = await get<{ trades?: LaunchpadTrade[] }>(
      `/pools/${pool}/trades`,
      "launchpad trades",
    );
    return res.trades ?? [];
  });
}

/**
 * What a wallet still holds on a curve, in raw shares.
 *
 * Curve shares are tracked by the programme rather than as SPL tokens, so a wallet balance is no
 * help here. The launchpad publishes holders read straight from chain, which is the authority; the
 * trade feed is only a fallback for when that read comes back empty on a pool that has clearly
 * traded, and it is derived by netting the wallet's own fills.
 */
export async function fetchPosition(
  pool: string,
  wallet: string,
  decimals: number,
): Promise<{ shares: string; source: "holders" | "trades" | "none" }> {
  const holders = await get<{ holders?: unknown[] }>(`/pools/${pool}/holders`, "curve holders");
  for (const raw of holders.holders ?? []) {
    const h = raw as Record<string, unknown>;
    const who = h.wallet ?? h.owner ?? h.trader ?? h.address ?? h.buyer;
    if (who !== wallet) continue;
    const shares = h.shares ?? h.activeShares ?? h.amount ?? h.balance;
    if (typeof shares === "string" || typeof shares === "number") {
      return { shares: String(shares).split(".")[0], source: "holders" };
    }
  }

  const trades = await fetchPoolTrades(pool);
  const mine = trades.filter((t) => t.trader === wallet);
  if (mine.length === 0) return { shares: "0", source: "none" };

  const net = mine.reduce((sum, t) => sum + (t.side === "buy" ? t.tokens : -t.tokens), 0);
  return { shares: net > 0 ? uiToRaw(net, decimals) : "0", source: "trades" };
}

/**
 * A wallet's own record on one curve, as the programme keeps it. After graduation the shares stay
 * there until the wallet claims them as real tokens, which it has to do itself.
 */
export async function fetchCurvePosition(
  pool: string,
  wallet: string,
): Promise<{ shares: string; graduatedTokensClaimed: boolean } | null> {
  const res = await get<{
    position?: { shares?: string | number; graduatedTokensClaimed?: boolean } | null;
  }>(`/pools/${pool}/position/${wallet}`, "curve position");
  const p = res.position;
  if (!p) return null;
  return {
    shares: String(p.shares ?? "0").split(".")[0],
    graduatedTokensClaimed: p.graduatedTokensClaimed === true,
  };
}

// --- Builds --------------------------------------------------------------------------------------

export async function buildBuyTx(body: {
  buyer: string;
  pool: string;
  paymentAmount: string;
  referrer?: string | null;
}): Promise<BuiltTx> {
  // Leaving `referrer` out means "use Coorwa's". Passing null means "deliberately none" - which is
  // how a creator buying their own curve gets through, since the programme rejects self-referral.
  const referrer =
    body.referrer === undefined ? COORWA_REFERRER || undefined : (body.referrer ?? undefined);
  return post("/tx/buy", { ...body, referrer }, "buy build");
}

export async function buildSellTx(body: {
  seller: string;
  pool: string;
  tokenShares: string;
  unwrap?: boolean;
}): Promise<BuiltTx> {
  return post("/tx/sell", body, "sell build");
}

export async function buildClaimCreatorFeesTx(body: {
  creator: string;
  pool: string;
  unwrap?: boolean;
}): Promise<BuiltTx> {
  return post("/tx/claim-creator-fees", body, "creator-fee claim build");
}

/** Shares on a graduated curve, turned into the token itself. Signed by the holder alone. */
export async function buildClaimGraduatedTx(body: {
  claimant: string;
  pool: string;
}): Promise<BuiltTx> {
  return post("/tx/claim", { ...body, kind: "graduated_tokens" }, "graduated claim build");
}

// --- Derived -------------------------------------------------------------------------------------

/** How far a pool is toward graduation, 0..1. */
export function graduationProgress(pool: LaunchpadPool): number {
  const target = Number(pool.graduationTarget);
  const raised = Number(pool.paymentRaisedNet);
  if (!Number.isFinite(target) || target <= 0) return 0;
  return Math.min(1, Math.max(0, raised / target));
}

/**
 * The fee split, expressed as a share of the TRADE rather than of the fee, which is how a trader
 * actually experiences it.
 */
export function feeBreakdown(config: LaunchpadConfig) {
  const trade = config.tradeFeeBps / 10_000;
  const share = (bps: number) => trade * (bps / 10_000);
  return {
    totalPct: trade * 100,
    creatorPct: share(config.creatorFeeBps) * 100,
    referralPct: share(config.referralFeeBps) * 100,
    treasuryPct: share(config.treasuryFeeBps) * 100,
    buybackPct: share(config.buybackFeeBps) * 100,
  };
}
