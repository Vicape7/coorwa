/**
 * Cookie Chain swap routing.
 *
 * Two independent aggregators cover the same liquidity, so Coorwa quotes both and takes the better
 * fill. Both hand back an UNSIGNED transaction that the user's wallet signs locally - Coorwa never
 * touches a key, and never holds funds.
 */
import { COOKIEBOX_AGG_API, CANDYSHOP_API, DEFAULT_SLIPPAGE_BPS } from "./config";
import { fetchJson, CoorwaError } from "./http";

export type Aggregator = "cookiebox" | "candyshop";

export interface RouteSegment {
  venue: string;
  poolAddress: string;
  inputMint?: string;
  outputMint?: string;
  inAmount: string;
  outAmount: string;
  hopIndex?: number;
  percentage?: number;
}

export interface SwapRoute {
  aggregator: Aggregator;
  inAmount: string;
  /** Net of the aggregator's own fee - this is what actually lands. */
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: number | null;
  feeBps: number | null;
  segments: RouteSegment[];
  path: string[];
  isSplit: boolean;
  isMultiHop: boolean;
  /** Opaque payload the matching build step needs. */
  raw: unknown;
}

// --- Cookiebox aggregator -----------------------------------------------------------------------

interface AggQuote {
  inAmount: string;
  outAmount: string;
  feePct: number;
  feeAmount: string;
  netOutAmount: string;
  minOutAmount: string;
  priceImpactPct: number | null;
  path: string[];
  isSplit: boolean;
  isMultiHop: boolean;
  segments: Array<{
    pool: string;
    venue: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    percentage?: number;
    hopIndex: number;
  }>;
}

async function quoteCookiebox(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  owner?: string,
): Promise<SwapRoute | null> {
  const q = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(slippageBps) });
  if (owner) q.set("owner", owner);
  try {
    const { route } = await fetchJson<{ route: AggQuote }>(`${COOKIEBOX_AGG_API}/quote?${q}`);
    return {
      aggregator: "cookiebox",
      inAmount: route.inAmount,
      outAmount: route.netOutAmount ?? route.outAmount,
      minOutAmount: route.minOutAmount,
      priceImpactPct: route.priceImpactPct,
      feeBps: route.feePct != null ? Math.round(route.feePct * 100) : null,
      segments: route.segments.map((s) => ({
        venue: s.venue,
        poolAddress: s.pool,
        inputMint: s.inputMint,
        outputMint: s.outputMint,
        inAmount: s.inAmount,
        outAmount: s.outAmount,
        hopIndex: s.hopIndex,
        percentage: s.percentage,
      })),
      path: route.path,
      isSplit: route.isSplit,
      isMultiHop: route.isMultiHop,
      raw: { inputMint, outputMint, amount, slippageBps },
    };
  } catch (e) {
    if (e instanceof CoorwaError && (e.status === 404 || /no route/i.test(e.message))) return null;
    throw e;
  }
}

/** The agg re-quotes server-side and returns an unsigned v0 tx. It can be slow on a cold route. */
export async function buildCookieboxTx(args: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  owner: string;
}): Promise<{ transactionBase64: string; blockhash: string; lastValidBlockHeight: number }> {
  return fetchJson(`${COOKIEBOX_AGG_API}/swap-tx`, {
    method: "POST",
    body: JSON.stringify(args),
    timeoutMs: 60_000,
  });
}

// --- Candy Shop -----------------------------------------------------------------------------------

interface CandyRoute {
  segments: Array<{
    dex: string;
    poolAddress: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct: number;
    percentage?: number;
    hopIndex?: number;
    inputMint?: string;
    outputMint?: string;
  }>;
  totalInAmount: string;
  totalOutAmount: string;
  grossOutAmount?: string;
  protocolFeeBps?: number;
  combinedPriceImpactPct: number;
  minOutAmount: string;
  route: string[];
  isSplit: boolean;
  isMultiHop: boolean;
}

async function quoteCandyshop(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
): Promise<SwapRoute | null> {
  const q = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(slippageBps) });
  try {
    const { multiRoute } = await fetchJson<{ multiRoute: CandyRoute }>(
      `${CANDYSHOP_API}/quote/multi-route?${q}`,
    );
    return {
      aggregator: "candyshop",
      inAmount: multiRoute.totalInAmount,
      outAmount: multiRoute.totalOutAmount,
      minOutAmount: multiRoute.minOutAmount,
      priceImpactPct: Number.isFinite(multiRoute.combinedPriceImpactPct)
        ? multiRoute.combinedPriceImpactPct
        : null,
      feeBps: multiRoute.protocolFeeBps ?? null,
      segments: multiRoute.segments.map((s) => ({
        venue: s.dex,
        poolAddress: s.poolAddress,
        inputMint: s.inputMint,
        outputMint: s.outputMint,
        inAmount: s.inAmount,
        outAmount: s.outAmount,
        hopIndex: s.hopIndex,
        percentage: s.percentage,
      })),
      path: multiRoute.route,
      isSplit: multiRoute.isSplit,
      isMultiHop: multiRoute.isMultiHop,
      raw: multiRoute,
    };
  } catch (e) {
    if (e instanceof CoorwaError && (e.status === 404 || /no route/i.test(e.message))) return null;
    throw e;
  }
}

export async function buildCandyshopTx(
  multiRoute: unknown,
  userPublicKey: string,
): Promise<{ transactionBase64: string }> {
  return fetchJson(`${CANDYSHOP_API}/swap-tx/multi-route`, {
    method: "POST",
    body: JSON.stringify({ multiRoute, userPublicKey }),
    timeoutMs: 45_000,
  });
}

export async function submitCandyshopTx(signedTransactionBase64: string) {
  return fetchJson<{ signature: string; confirmed: boolean }>(`${CANDYSHOP_API}/submit-tx`, {
    method: "POST",
    body: JSON.stringify({ signedTransactionBase64 }),
    timeoutMs: 45_000,
  });
}

// --- Best-of ---------------------------------------------------------------------------------------

/** Quote both routers in parallel and keep whichever fills better. A failing router is ignored. */
export async function bestQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  owner?: string;
}): Promise<{ best: SwapRoute; all: SwapRoute[] }> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (args.inputMint === args.outputMint) {
    throw new CoorwaError("input and output mint must differ");
  }

  const settled = await Promise.allSettled([
    quoteCookiebox(args.inputMint, args.outputMint, args.amount, slippageBps, args.owner),
    quoteCandyshop(args.inputMint, args.outputMint, args.amount, slippageBps),
  ]);

  const all = settled
    .filter((r): r is PromiseFulfilledResult<SwapRoute | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((r): r is SwapRoute => r != null);

  if (all.length === 0) {
    const reasons = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    throw new CoorwaError(
      "no route found on Cookie Chain",
      reasons[0] ?? "neither aggregator could price this pair - the pool may be too thin",
    );
  }

  all.sort((a, b) => (BigInt(b.outAmount) > BigInt(a.outAmount) ? 1 : -1));
  return { best: all[0], all };
}
