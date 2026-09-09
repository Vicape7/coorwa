/**
 * Cross-chain settlement: turning a Cookie Chain token into a real RWA position.
 *
 * Corwa deliberately does NOT wrap xStocks onto Cookie Chain. Their mints carry a permanent
 * delegate, a pause authority, a freeze authority and a live rebase multiplier — a bridged
 * representation could be drained, frozen or silently drift away from its backing. So instead of
 * escrowing the asset, Corwa routes the user into it, and the xStock lands in their own Solana
 * wallet where all of that is Backed's problem and Jupiter's job.
 *
 * The route is three legs, each of which already exists in production:
 *
 *   TOKEN --[Cookie Chain aggregator]--> COOK --[Hyperlane warp]--> COOK (Solana) --[Jupiter]--> xSTOCK
 *
 * The capacity ceiling is leg 3: bridged COOK is thin on Solana, so this planner measures the real
 * price impact rather than assuming it away, and says plainly when a size is too big.
 */
import {
  COOK_MINT,
  COOK_DECIMALS,
  COOK_SOLANA_MINT,
  COOK_SOLANA_DECIMALS,
  DEFAULT_SLIPPAGE_BPS,
} from "./config";
import { bestQuote, type SwapRoute } from "./swap";
import { jupQuote, routeLabels, type JupQuote } from "./jupiter";
import { rwaByTicker, type RwaAsset } from "./rwa";
import { rawToUi, uiToRaw } from "./format";
import { CorwaError } from "./http";

export interface RouteLeg {
  kind: "cookie-swap" | "bridge" | "solana-swap";
  label: string;
  venue: string;
  inSymbol: string;
  outSymbol: string;
  inAmount: number;
  outAmount: number;
  priceImpactPct: number | null;
  /** Rough wall-clock cost of this leg, for the progress UI. */
  etaSeconds: number;
  note?: string;
}

export interface CrossChainPlan {
  asset: RwaAsset;
  legs: RouteLeg[];
  input: { mint: string; symbol: string; amount: number };
  /** RWA shares the user ends up holding on Solana. */
  outputShares: number;
  outputUsd: number;
  /** Combined slippage across every leg, measured rather than assumed. */
  totalPriceImpactPct: number;
  etaSeconds: number;
  warnings: string[];
  /** Payloads the executor needs, kept opaque to the UI. */
  cookieRoute: SwapRoute | null;
  solanaQuote: JupQuote;
}

/** Bridge fee is paid in COOK for interchain gas; this is the observed order of magnitude. */
const BRIDGE_GAS_COOK = 0.002;
const BRIDGE_ETA_SECONDS = 180;

/** Above this, the Solana leg is eating the trade and the user should be told, not just charged. */
const IMPACT_WARN_PCT = 2;
const IMPACT_BLOCK_PCT = 10;

export async function planCrossChainBuy(args: {
  /** Cookie Chain mint being sold. Pass COOK_MINT to start from COOK directly. */
  inputMint: string;
  inputSymbol: string;
  inputDecimals: number;
  /** UI amount of the input token. */
  amount: number;
  /** RWA ticker, e.g. "NVDA". */
  ticker: string;
  slippageBps?: number;
  owner?: string;
}): Promise<CrossChainPlan> {
  const asset = rwaByTicker(args.ticker);
  if (!asset) throw new CorwaError(`unknown RWA: ${args.ticker}`);
  if (!(args.amount > 0)) throw new CorwaError("amount must be positive");

  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const legs: RouteLeg[] = [];
  const warnings: string[] = [];

  // --- Leg 1: TOKEN -> COOK on Cookie Chain ---
  let cookAmount: number;
  let cookieRoute: SwapRoute | null = null;

  if (args.inputMint === COOK_MINT) {
    cookAmount = args.amount;
  } else {
    const { best } = await bestQuote({
      inputMint: args.inputMint,
      outputMint: COOK_MINT,
      amount: uiToRaw(args.amount, args.inputDecimals),
      slippageBps,
      owner: args.owner,
    });
    cookieRoute = best;
    cookAmount = rawToUi(best.outAmount, COOK_DECIMALS);
    legs.push({
      kind: "cookie-swap",
      label: `Sell ${args.inputSymbol} for COOK`,
      venue: best.segments.map((s) => s.venue).join(" + ") || best.aggregator,
      inSymbol: args.inputSymbol,
      outSymbol: "COOK",
      inAmount: args.amount,
      outAmount: cookAmount,
      priceImpactPct: best.priceImpactPct,
      etaSeconds: 5,
      note: `routed by ${best.aggregator}`,
    });
  }

  // --- Leg 2: bridge COOK to Solana over Hyperlane (1:1, minus interchain gas) ---
  const bridged = Math.max(0, cookAmount - BRIDGE_GAS_COOK);
  if (bridged <= 0) {
    throw new CorwaError(
      "amount too small to bridge",
      `the Hyperlane leg costs about ${BRIDGE_GAS_COOK} COOK in interchain gas`,
    );
  }
  legs.push({
    kind: "bridge",
    label: "Bridge COOK to Solana",
    venue: "Hyperlane warp route",
    inSymbol: "COOK",
    outSymbol: "COOK",
    inAmount: cookAmount,
    outAmount: bridged,
    priceImpactPct: 0,
    etaSeconds: BRIDGE_ETA_SECONDS,
    note: "1:1, a relayer delivers on the far side",
  });

  // --- Leg 3: COOK -> xStock on Solana via Jupiter ---
  const solQuote = await jupQuote({
    inputMint: COOK_SOLANA_MINT,
    outputMint: asset.mint,
    amount: uiToRaw(bridged, COOK_SOLANA_DECIMALS),
    slippageBps,
  });

  const shares = rawToUi(solQuote.outAmount, asset.decimals);
  const solImpact = Number(solQuote.priceImpactPct) * 100;

  legs.push({
    kind: "solana-swap",
    label: `Buy ${asset.symbol} with COOK`,
    venue: routeLabels(solQuote).join(" → ") || "Jupiter",
    inSymbol: "COOK",
    outSymbol: asset.symbol,
    inAmount: bridged,
    outAmount: shares,
    priceImpactPct: Number.isFinite(solImpact) ? solImpact : null,
    etaSeconds: 10,
    note: "settles in your own Solana wallet",
  });

  const totalImpact = legs.reduce((sum, l) => sum + (l.priceImpactPct ?? 0), 0);

  if (solImpact >= IMPACT_BLOCK_PCT) {
    warnings.push(
      `The Solana leg would move the price ${solImpact.toFixed(1)}%. Bridged COOK is thin — split this into smaller trades.`,
    );
  } else if (totalImpact >= IMPACT_WARN_PCT) {
    warnings.push(
      `Total slippage across the route is about ${totalImpact.toFixed(1)}%, most of it on the COOK/${asset.symbol} leg.`,
    );
  }
  warnings.push(
    "The bridge leg is asynchronous. Your COOK is locked as soon as leg 2 sends, and the final buy only becomes possible once a relayer delivers it — usually a few minutes.",
  );

  return {
    asset,
    legs,
    input: { mint: args.inputMint, symbol: args.inputSymbol, amount: args.amount },
    outputShares: shares,
    outputUsd: 0, // filled in by the caller, which already holds the RWA price
    totalPriceImpactPct: totalImpact,
    etaSeconds: legs.reduce((s, l) => s + l.etaSeconds, 0),
    warnings,
    cookieRoute,
    solanaQuote: solQuote,
  };
}
