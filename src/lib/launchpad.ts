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
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { MOMOSWAP_API, CORWA_REFERRER } from "./config";
import { fetchJson, cachedStale, CorwaError } from "./http";
import { uiToRaw } from "./format";

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

/** A raw ed25519 key wrapped as DER, which is the only shape node's verifier accepts. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Check the wallet signed the message Corwa handed it, before spending an upstream call on it.
 *
 * MomoSwap answers anything it does not like with a flat `401 Invalid signature`, which covers at
 * least three different mistakes: a wallet that signed with a different account than the one it
 * reports, a wallet that altered the message before signing, and a message rebuilt from mismatched
 * parts. Re-deriving the message here and verifying against the wallet address separates the first
 * two from the rest, so the page can say which one happened instead of forwarding a shrug.
 */
export function verifyLoginSignature(args: {
  wallet: string;
  ts: number;
  nonce: string;
  signature: string;
}): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(bs58.decode(args.wallet))]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(loginMessage(args.wallet, args.ts, args.nonce), "utf8"),
      key,
      Buffer.from(bs58.decode(args.signature)),
    );
  } catch {
    // A malformed address or signature is not a verified one, which is all the caller needs.
    return false;
  }
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
  // Leaving `referrer` out means "use Corwa's". Passing null means "deliberately none" - which is
  // how a creator buying their own curve gets through, since the programme rejects self-referral.
  const referrer =
    body.referrer === undefined ? CORWA_REFERRER || undefined : (body.referrer ?? undefined);
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
