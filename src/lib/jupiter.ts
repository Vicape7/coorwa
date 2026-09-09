/**
 * Jupiter client - the Solana-mainnet half of Corwa.
 *
 * Two jobs: price the RWA assets that Corwa denominates pairs in, and quote/build the final leg of
 * a cross-chain route (bridged COOK -> xStock). The keyless tier allows 0.5 req/s, so every call
 * here is cached and callers must go through our API routes rather than hitting it from a browser.
 */
import { JUPITER_API, COOK_SOLANA_MINT } from "./config";
import { fetchJson, cachedStale } from "./http";
import { RWA_ASSETS } from "./rwa";

const authHeaders: Record<string, string> = process.env.JUPITER_API_KEY
  ? { "x-api-key": process.env.JUPITER_API_KEY }
  : {};

export interface JupToken {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  usdPrice: number;
  liquidity?: number;
  mcap?: number;
  holderCount?: number;
  stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number };
  stats1h?: { priceChange?: number };
}

export interface RwaQuote {
  ticker: string;
  symbol: string;
  mint: string;
  priceUsd: number;
  change24h: number | null;
  liquidityUsd: number | null;
}

/**
 * Live USD price for every RWA in the registry, plus bridged COOK.
 *
 * Jupiter's search endpoint takes one query at a time, so this walks the registry sequentially
 * with a small delay - well inside the keyless rate limit, and the result is cached for 30s.
 */
async function loadRwaPrices(): Promise<Record<string, RwaQuote>> {
  const out: Record<string, RwaQuote> = {};
  for (const asset of RWA_ASSETS) {
    try {
      const res = await fetchJson<JupToken[]>(
        `${JUPITER_API}/tokens/v2/search?query=${encodeURIComponent(asset.mint)}`,
        { headers: authHeaders },
      );
      const t = res?.find((x) => x.id === asset.mint) ?? res?.[0];
      if (!t || !Number.isFinite(t.usdPrice)) continue;
      out[asset.ticker] = {
        ticker: asset.ticker,
        symbol: asset.symbol,
        mint: asset.mint,
        priceUsd: t.usdPrice,
        change24h: t.stats24h?.priceChange ?? null,
        liquidityUsd: t.liquidity ?? null,
      };
    } catch {
      // One unavailable asset must not blank the whole board.
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

export async function fetchRwaPrices(): Promise<Record<string, RwaQuote>> {
  return cachedStale("jupiter:rwa", 30_000, loadRwaPrices);
}

/** COOK's price and depth on Solana mainnet - the capacity ceiling for cross-chain routing. */
export async function fetchCookOnSolana(): Promise<JupToken | null> {
  return cachedStale("jupiter:cook", 30_000, async () => {
    const res = await fetchJson<JupToken[]>(
      `${JUPITER_API}/tokens/v2/search?query=${COOK_SOLANA_MINT}`,
      { headers: authHeaders },
    );
    return res?.find((x) => x.id === COOK_SOLANA_MINT) ?? null;
  });
}

// --- Swap quoting (the Solana leg of a cross-chain route) ---------------------------------------

export interface JupQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: Array<{ swapInfo: { label: string; ammKey: string } }>;
  [k: string]: unknown;
}

export async function jupQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}): Promise<JupQuote> {
  const q = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    slippageBps: String(args.slippageBps),
  });
  return fetchJson<JupQuote>(`${JUPITER_API}/swap/v1/quote?${q}`, { headers: authHeaders });
}

/** Returns a fully built, unsigned v0 transaction carrying its own blockhash. */
export async function jupSwapTx(args: {
  quoteResponse: JupQuote;
  userPublicKey: string;
}): Promise<{ swapTransaction: string; lastValidBlockHeight: number }> {
  return fetchJson(`${JUPITER_API}/swap/v1/swap`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      quoteResponse: args.quoteResponse,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
    timeoutMs: 30_000,
  });
}

export function routeLabels(q: JupQuote): string[] {
  return q.routePlan?.map((r) => r.swapInfo.label) ?? [];
}
