/**
 * MomoSwap launchpad client - Cookie Chain's bonding-curve launchpad.
 *
 * Its API serves the pool reads and BUILDS every launchpad transaction: it leases a pre-ground
 * `momo`-suffixed mint (the program enforces that suffix on-chain), pins metadata to IPFS, and
 * returns an unsigned, partially-signed transaction. Corwa simulates and the user's wallet signs,
 * so the flow stays non-custodial.
 *
 * Why Corwa cares: the launchpad splits its 1% trade fee, and 20% of that goes to whoever is named
 * as referrer. With no referrer the programme keeps that share itself - so naming Corwa costs the
 * trader nothing and is the honest source of the launchpad half of cashback.
 */
import { MOMOSWAP_API, CORWA_REFERRER } from "./config";
import { fetchJson, cachedStale, CorwaError } from "./http";

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
}

export interface BuiltTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** create-pool only: the leased `momo` mint the token will be created at. */
  mint?: string;
}

type Envelope<T> = T & { success?: boolean; error?: string };

function unwrap<T>(res: Envelope<T>, what: string): T {
  if (res.success === false) {
    throw new CorwaError(res.error ?? `${what} failed`, "check the inputs and retry");
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
    const res = await get<{ pools?: LaunchpadPool[] }>(`/pools?status=${status}`, "launchpad pools");
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

// --- Session (the launch path is signature-gated) -----------------------------------------------

/**
 * The login message the launchpad verifies. Line order and the domain string are part of the
 * contract - the server re-derives this exact string, so any drift reads as a forged signature.
 */
export function loginMessage(wallet: string, ts: number, nonce: string): string {
  return `MOMO Login\ndomain: momoswap.fun\nnonce: ${nonce}\nwallet: ${wallet}\nts: ${ts}`;
}

export async function fetchLoginNonce(): Promise<{ nonce: string; ttlSecs?: number }> {
  return get<{ nonce: string; ttlSecs?: number }>("/session/nonce", "login nonce");
}

export async function createSession(body: {
  wallet: string;
  ts: number;
  nonce: string;
  signature: string;
}): Promise<{ token: string; wallet: string; expiresAt: number }> {
  return post("/session", body, "launchpad session");
}

// --- Builds --------------------------------------------------------------------------------------

export interface CreatePoolParams {
  name: string;
  symbol: string;
  launch_ts: number;
  duration_secs: number;
  expiry_mode: ExpiryMode;
  migratable: boolean;
  anti_snipe: boolean;
  min_buy: string;
  max_buy_per_wallet: string;
  max_payment_raise: string;
}

export async function uploadImage(imageBase64: string, contentType: string): Promise<string> {
  const res = await post<{ url?: string }>(
    "/image",
    { imageBase64, contentType },
    "token image upload",
  );
  if (!res.url) {
    throw new CorwaError(
      "the launchpad did not return an image URL",
      "retry, or supply an already-hosted image URL instead",
    );
  }
  return res.url;
}

export async function buildCreatePoolTx(body: {
  creator: string;
  params: CreatePoolParams;
  metadata: { name: string; symbol: string; description?: string; image?: string };
  devBuyCook?: string;
  session: string;
}): Promise<BuiltTx> {
  return post("/tx/create-pool", body, "launch build", 60_000);
}

export async function buildBuyTx(body: {
  buyer: string;
  pool: string;
  paymentAmount: string;
  referrer?: string | null;
}): Promise<BuiltTx> {
  return post(
    "/tx/buy",
    // The programme rejects self-referral, so a creator buying their own curve drops the referrer.
    { ...body, referrer: body.referrer ?? (CORWA_REFERRER || undefined) },
    "buy build",
  );
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
