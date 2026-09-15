/**
 * Cross-chain settlement: turning a Cookie Chain token into a real RWA position.
 *
 * Coorwa deliberately does NOT wrap xStocks onto Cookie Chain. Their mints carry a permanent
 * delegate, a pause authority, a freeze authority and a live rebase multiplier - a bridged
 * representation could be drained, frozen or silently drift away from its backing. So instead of
 * escrowing the asset, Coorwa routes the user into it, and the xStock lands in their own Solana
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
import { CoorwaError } from "./http";

export interface RouteLeg {
  /**
   * "claim" and "lp-claim" only ever open a payout: this route with the vault, or an LP position's
   * fees, in front of it.
   */
  kind: "claim" | "lp-claim" | "cookie-swap" | "bridge" | "solana-swap";
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

/**
 * Interchain gas for a Cookie Chain dispatch, paid in COOK. Simulating a transfer on 2026-09-11
 * showed the IGP charging 0.0041 COOK for 112,000 gas. Rounded up, because this only shapes the
 * estimate: the executor bridges what it measured and the dispatch pays whatever gas really costs.
 */
const BRIDGE_GAS_COOK = 0.005;
const BRIDGE_ETA_SECONDS = 180;

/** Above this, the Solana leg is eating the trade and the user should be told, not just charged. */
const IMPACT_WARN_PCT = 2;
const IMPACT_BLOCK_PCT = 10;

/**
 * Name the leg actually carrying the most slippage.
 *
 * Which one it is depends on the size and on the day. The Solana leg is usually the thin one, but a
 * large trade against a shallow Cookie Chain pool flips it, and a warning that names the wrong leg
 * sends the user to shrink the wrong side of the trade.
 */
function worstLeg(legs: RouteLeg[]): RouteLeg | null {
  return legs.reduce<RouteLeg | null>(
    (worst, leg) => ((leg.priceImpactPct ?? 0) > (worst?.priceImpactPct ?? 0) ? leg : worst),
    null,
  );
}

/** Reads as "the COOK/NVDAx leg", or "one leg" when no leg reports an impact at all. */
function worstLegLabel(legs: RouteLeg[]): string {
  const worst = worstLeg(legs);
  return worst ? `the ${worst.inSymbol}/${worst.outSymbol} leg` : "one leg";
}

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
  /**
   * COOK that joins the route after leg 1 without being swapped for, as a UI amount. An LP fee claim
   * pays both sides of the pool, so its COOK side goes straight to the bridge next to what the
   * other side sells for.
   */
  plusCook?: number;
}): Promise<CrossChainPlan> {
  const asset = rwaByTicker(args.ticker);
  if (!asset) throw new CoorwaError(`unknown RWA: ${args.ticker}`);
  if (!(args.amount > 0)) throw new CoorwaError("amount must be positive");

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

  cookAmount += args.plusCook ?? 0;

  // --- Leg 2: bridge COOK to Solana over Hyperlane (1:1, minus interchain gas) ---
  const bridged = Math.max(0, cookAmount - BRIDGE_GAS_COOK);
  if (bridged <= 0) {
    throw new CoorwaError(
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
      `The Solana leg would move the price ${solImpact.toFixed(1)}%. Bridged COOK is thin - split this into smaller trades.`,
    );
  } else if (totalImpact >= IMPACT_WARN_PCT) {
    warnings.push(
      `Total slippage across the route is about ${totalImpact.toFixed(1)}%, most of it on ` +
        `${worstLegLabel(legs)}.`,
    );
  }
  warnings.push(
    "The bridge leg is asynchronous. Your COOK is locked as soon as leg 2 sends, and the final buy only becomes possible once a relayer delivers it - usually a few minutes.",
  );

  return {
    asset,
    legs,
    input: {
      mint: args.inputMint,
      symbol: args.inputSymbol,
      amount: args.amount,
    },
    outputShares: shares,
    outputUsd: 0, // filled in by the caller, which already holds the RWA price
    totalPriceImpactPct: totalImpact,
    etaSeconds: legs.reduce((s, l) => s + l.etaSeconds, 0),
    warnings,
    cookieRoute,
    solanaQuote: solQuote,
  };
}

// --- The way back --------------------------------------------------------------------------------

export interface CrossChainSellPlan {
  asset: RwaAsset;
  legs: RouteLeg[];
  input: { ticker: string; symbol: string; shares: number; amountRaw: string };
  output: { mint: string; symbol: string; amount: number };
  /** Filled in by the caller, which already holds the RWA price. */
  inputUsd: number;
  totalPriceImpactPct: number;
  etaSeconds: number;
  warnings: string[];
  solanaQuote: JupQuote;
  cookieRoute: SwapRoute | null;
}

/**
 * The reverse leg: a real xStock on Solana back into a Cookie Chain token.
 *
 *   xSTOCK --[Jupiter]--> COOK (Solana) --[Hyperlane warp]--> COOK --[Cookie Chain aggregator]--> TOKEN
 *
 * This is what turns "priced in NVDA" into a real TOKEN/NVDA market. With `planCrossChainBuy` on
 * its own, a share is somewhere you can only arrive. A pair you can only leave in one direction is
 * a quote, not a market.
 *
 * Two things here are genuinely different from the buy direction, not just mirrored:
 *
 *  1. The capacity limit moves to the other side. Buying is limited by how thin bridged COOK is on
 *     Solana. Selling is limited by how much native COOK the Cookie Chain warp route can release,
 *     because `resolveRoute("solana-to-cookie")` returns a collateral route pointing at the native
 *     PDA. `preflightBridge` still enforces that before anything is signed. The warning below just
 *     gives the user a chance to pick a smaller size first.
 *
 *  2. Interchain gas is paid in SOL, not COOK. Hyperlane charges its gas in the source chain's own
 *     native token, so going this way the full COOK amount crosses and the user needs SOL instead.
 *     The buy direction subtracts COOK only because COOK is the native token on Cookie Chain.
 */
export async function planCrossChainSell(args: {
  /** RWA ticker being sold, e.g. "NVDA". */
  ticker: string;
  /**
   * Raw units of the xStock, NOT a display amount.
   *
   * xStocks carry `scaledUiAmountConfig`, so the balance a holder sees is the raw amount times a
   * multiplier that changes on dividends and splits. Converting a typed-in share count using the
   * mint's decimals would therefore be wrong by exactly that multiplier. The caller reads the token
   * account, which the RPC has already scaled, and passes the raw figure straight through.
   */
  amountRaw: string;
  /** The scaled balance the holder actually sees, for labelling only. */
  shares: number;
  /** Cookie Chain mint to end in. Pass COOK_MINT to stop at COOK. */
  outputMint: string;
  outputSymbol: string;
  outputDecimals: number;
  slippageBps?: number;
  /** Cookie Chain address, so the final leg can be quoted for the actual recipient. */
  owner?: string;
}): Promise<CrossChainSellPlan> {
  const asset = rwaByTicker(args.ticker);
  if (!asset) throw new CoorwaError(`unknown RWA: ${args.ticker}`);
  if (!(BigInt(args.amountRaw) > 0n)) throw new CoorwaError("amount must be positive");

  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const legs: RouteLeg[] = [];
  const warnings: string[] = [];

  // --- Leg 1: xStock -> COOK on Solana via Jupiter ---
  const solQuote = await jupQuote({
    inputMint: asset.mint,
    outputMint: COOK_SOLANA_MINT,
    amount: args.amountRaw,
    slippageBps,
  });

  const cookOnSolana = rawToUi(solQuote.outAmount, COOK_SOLANA_DECIMALS);
  const solImpact = Number(solQuote.priceImpactPct) * 100;

  legs.push({
    kind: "solana-swap",
    label: `Sell ${asset.symbol} for COOK`,
    venue: routeLabels(solQuote).join(" → ") || "Jupiter",
    inSymbol: asset.symbol,
    outSymbol: "COOK",
    inAmount: args.shares,
    outAmount: cookOnSolana,
    priceImpactPct: Number.isFinite(solImpact) ? solImpact : null,
    etaSeconds: 10,
    note: "signed from your own Solana wallet",
  });

  // --- Leg 2: bridge COOK back to Cookie Chain ---
  if (cookOnSolana <= 0) {
    throw new CoorwaError(
      "that size does not clear the Solana leg",
      "the COOK pool on Solana is thin enough that this sale rounds to nothing",
    );
  }
  legs.push({
    kind: "bridge",
    label: "Bridge COOK to Cookie Chain",
    venue: "Hyperlane warp route",
    inSymbol: "COOK",
    outSymbol: "COOK",
    inAmount: cookOnSolana,
    outAmount: cookOnSolana,
    priceImpactPct: 0,
    etaSeconds: BRIDGE_ETA_SECONDS,
    note: "1:1 - interchain gas is charged in SOL on this side, not taken out of the COOK",
  });

  // --- Leg 3: COOK -> TOKEN on Cookie Chain ---
  let outAmount = cookOnSolana;
  let cookieRoute: SwapRoute | null = null;

  if (args.outputMint !== COOK_MINT) {
    const { best } = await bestQuote({
      inputMint: COOK_MINT,
      outputMint: args.outputMint,
      amount: uiToRaw(cookOnSolana, COOK_DECIMALS),
      slippageBps,
      owner: args.owner,
    });
    cookieRoute = best;
    outAmount = rawToUi(best.outAmount, args.outputDecimals);
    legs.push({
      kind: "cookie-swap",
      label: `Buy ${args.outputSymbol} with COOK`,
      venue: best.segments.map((s) => s.venue).join(" + ") || best.aggregator,
      inSymbol: "COOK",
      outSymbol: args.outputSymbol,
      inAmount: cookOnSolana,
      outAmount,
      priceImpactPct: best.priceImpactPct,
      etaSeconds: 5,
      note: `routed by ${best.aggregator}`,
    });
  }

  const totalImpact = legs.reduce((sum, l) => sum + (l.priceImpactPct ?? 0), 0);

  if (solImpact >= IMPACT_BLOCK_PCT) {
    warnings.push(
      `Selling this many ${asset.symbol} would move the COOK price ${solImpact.toFixed(1)}%. ` +
        "Bridged COOK is thin on Solana - split this into smaller sales.",
    );
  } else if (totalImpact >= IMPACT_WARN_PCT) {
    warnings.push(
      `Total slippage across the route is about ${totalImpact.toFixed(1)}%, most of it on ` +
        `${worstLegLabel(legs)}.`,
    );
  }

  warnings.push(
    "Leg 1 is subject to the issuer's controls, not Coorwa's: an xStock mint can be paused and an " +
      "individual account frozen, and either would stop the sale before it starts.",
  );
  warnings.push(
    "The bridge leg is asynchronous and releases native COOK from a fixed collateral account on " +
      "Cookie Chain. The balance there is checked before anything is signed.",
  );
  warnings.push("You need a little SOL for the Solana legs - the interchain gas is charged there.");

  return {
    asset,
    legs,
    input: {
      ticker: asset.ticker,
      symbol: asset.symbol,
      shares: args.shares,
      amountRaw: args.amountRaw,
    },
    output: {
      mint: args.outputMint,
      symbol: args.outputSymbol,
      amount: outAmount,
    },
    inputUsd: 0,
    totalPriceImpactPct: totalImpact,
    etaSeconds: legs.reduce((s, l) => s + l.etaSeconds, 0),
    warnings,
    solanaQuote: solQuote,
    cookieRoute,
  };
}
