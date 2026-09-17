"use client";

/**
 * The executor for a cross-chain route, in both directions, resumable from the middle.
 *
 *   buy     TOKEN --[Cookie agg]--> COOK --[Hyperlane]--> COOK (Solana) --[Jupiter]--> xSTOCK
 *   sell    xSTOCK --[Jupiter]--> COOK (Solana) --[Hyperlane]--> COOK --[Cookie agg]--> TOKEN
 *   LP fees position --[claim fees]--> TOKEN + COOK --[Cookie agg]--> COOK --[Hyperlane]--> ...
 *   creator pool --[claim creator fees]--> COOK --[Hyperlane]--> COOK (Solana) --[Jupiter]--> xSTOCK
 *
 * `crosschain.ts` prices these routes. This signs them. The two directions share every leg runner
 * they can, because the awkward part is the same on both sides: the bridge is asynchronous, so a
 * failure after it has dispatched is not a failed trade but a half-finished one, and the user's
 * funds are sitting on the other chain either way.
 *
 * Three rules run through every leg here, and they are what make a resume safe:
 *
 *  1. **Check before you send.** A leg that already has a signature is looked up on chain first.
 *     A confirmation that timed out on a throttled RPC still landed, and re-sending it would make
 *     the user pay twice.
 *  2. **Measure, do not quote.** Whatever crosses the bridge is read out of the previous
 *     transaction's own balance delta. A quote is a prediction; a delta is what happened.
 *  3. **Advance the cursor last.** `journey.cursor` moves only after a leg has fully confirmed and
 *     its measurement is stored. Anything that throws before that leaves the route pointing at the
 *     leg that still has to happen, which is exactly where a resume must restart.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { COOK_DECIMALS, COOK_MINT, COOK_SOLANA_DECIMALS, COOK_SOLANA_MINT } from "./config";
import { buildBridgeTransfer, messageIdFromLogs } from "./bridge";
import { lpClaimedCook, lpToBridge } from "./payout";
import { decodeTx, simulate, explainError, type SignerFn } from "./tx";
import { amount as fmtAmount, rawToUi, shortAddr, uiToRaw } from "./format";
import { CoorwaError } from "./http";
import type { Journey, JourneyStep } from "./journey";

/**
 * Native COOK held back on Cookie Chain so the next transaction there can pay its own fee. COOK is
 * the gas token, so spending the whole balance would strand the route one leg short.
 */
const COOKIE_GAS_RESERVE = 0.01;

/** How long to wait for a relayer before handing the route back to the user as resumable. */
const DELIVERY_TIMEOUT_MS = 15 * 60_000;
const DELIVERY_POLL_MS = 6_000;

/** Delivery is accepted at 90% of what was sent: the far side truncates when it rescales decimals. */
const DELIVERY_TOLERANCE = 0.9;

export interface RunContext {
  cookieConn: Connection;
  solanaConn: Connection;
  owner: PublicKey;
  signTransaction: SignerFn;
  slippageBps: number;
  /** Persist and re-render. Returns the stored journey, which is what the run continues from. */
  onChange: (j: Journey) => Journey;
}

/** The mutable handle each leg runner works through, so no runner holds a stale journey. */
interface Ctl {
  get(): Journey;
  update(patch: Partial<Journey>): void;
  setStep(i: number, patch: Partial<JourneyStep>): void;
}

type LegRunner = (ctl: Ctl, ctx: RunContext, i: number) => Promise<void>;

// --- Entry point --------------------------------------------------------------------------------

/**
 * Run a journey from wherever its cursor points, to the end.
 *
 * Never throws. A failure is a state the user has to see and act on, not an exception for the
 * panel to catch and turn back into a state.
 */
export async function runJourney(start: Journey, ctx: RunContext): Promise<Journey> {
  let j = ctx.onChange({ ...start, status: "running" });

  const ctl: Ctl = {
    get: () => j,
    update: (patch) => {
      j = ctx.onChange({ ...j, ...patch });
    },
    setStep: (i, patch) => {
      const steps = j.steps.slice();
      steps[i] = { ...(steps[i] ?? { state: "idle" }), ...patch };
      j = ctx.onChange({ ...j, steps });
    },
  };

  const runners = legRunners(j);

  for (let i = j.cursor; i < runners.length; i++) {
    try {
      await runners[i](ctl, ctx, i);
      ctl.update({ cursor: i + 1 });
    } catch (e) {
      ctl.setStep(i, { state: "failed", error: describe(e) });
      ctl.update({ status: "interrupted" });
      return j;
    }
  }

  ctl.update({ status: "done" });
  return j;
}

/**
 * Map the plan's legs onto runners. The plan drops a leg when the Cookie Chain side of the pair is
 * COOK itself, so this indexes off `journey.legs` rather than assuming there are always three.
 */
function legRunners(j: Journey): LegRunner[] {
  return j.legs.map(({ kind }) => {
    if (kind === "lp-claim") return claimLpFees;
    if (kind === "creator-claim") return claimCreatorFees;
    if (kind === "bridge") return bridgeLeg;
    if (j.direction === "buy") return kind === "cookie-swap" ? sellTokenForCook : deliverThenBuyRwa;
    return kind === "solana-swap" ? sellRwaForCook : deliverThenBuyToken;
  });
}

// --- Leg 1, buy: TOKEN -> COOK on Cookie Chain ---------------------------------------------------

const sellTokenForCook: LegRunner = async (ctl, ctx, i) => {
  const j = ctl.get();
  const reserve = BigInt(uiToRaw(COOKIE_GAS_RESERVE, COOK_DECIMALS));

  // After an LP fee claim the amount to sell is what the claim paid, measured, not what was typed.
  const lp = j.legs[0]?.kind === "lp-claim";
  if (lp && (j.sellRaw === undefined || j.lpClaimedLamports === undefined)) {
    throw new CoorwaError(
      "The fee claim has no measured amounts to sell.",
      "Nothing has been sold. The fees are in your Cookie Chain wallet. Resume the payout and the " +
        "claim leg will read them again without re-signing it.",
    );
  }
  const sellRaw = lp ? j.sellRaw! : uiToRaw(j.input.amount, j.token.decimals);

  if (lp && BigInt(sellRaw) <= 0n) {
    // The fees on this side rounded to nothing by the time the claim landed. Bridge the COOK alone.
    const toBridge = lpToBridge(BigInt(j.lpClaimedLamports!), 0n, reserve);
    if (toBridge <= 0n) throw tooLittleToBridge();
    ctl.update({ bridgeAmount: rawToUi(toBridge, COOK_DECIMALS) });
    ctl.setStep(i, { state: "done", detail: `No ${j.token.symbol} to sell` });
    return;
  }

  ctl.setStep(i, {
    state: "running",
    detail: `Selling ${fmtAmount(rawToUi(sellRaw, j.token.decimals))} ${j.token.symbol} for COOK`,
  });

  let signature = await landedSignature(ctx.cookieConn, j.steps[i]?.signature);
  if (!signature) {
    // A sale pays Coorwa's 1% on the COOK it produces, so the build needs the quoted output,
    // exactly as the terminal's own swap panel sends it.
    const quote = await getJson<{ all: { aggregator: string; outAmount: string }[] }>(
      `/api/quote?${new URLSearchParams({
        inputMint: j.token.mint,
        outputMint: COOK_MINT,
        amount: sellRaw,
        slippageBps: String(ctx.slippageBps),
        owner: ctx.owner.toBase58(),
      })}`,
    );
    const built = await postJson<{ transactionBase64: string }>("/api/swap/build", {
      aggregator: "cookiebox",
      owner: ctx.owner.toBase58(),
      inputMint: j.token.mint,
      outputMint: COOK_MINT,
      amount: sellRaw,
      slippageBps: ctx.slippageBps,
      outAmount: quote.all.find((r) => r.aggregator === "cookiebox")?.outAmount,
    });
    signature = await sendAndRecord(
      ctx.cookieConn,
      decodeTx(built.transactionBase64),
      ctx,
      ctl,
      i,
      "cookie",
    );
  }

  // What the swap actually produced, net of its own fee, read off the transaction itself.
  reportSwap(ctx, j, signature, "sell");

  const parsed = await fetchParsed(ctx.cookieConn, signature);
  const gained = cookieNativeLamports(parsed, ctx.owner);
  if (gained === null) {
    throw new CoorwaError(
      "The swap landed, but its result could not be read back.",
      "Nothing is lost and nothing was sent twice. Your COOK is in your Cookie Chain wallet. " +
        "Resume the route and it will read the amount again without re-signing this leg.",
    );
  }

  const toBridge = lp
    ? lpToBridge(BigInt(j.lpClaimedLamports!), gained, reserve)
    : gained - reserve;
  if (toBridge <= 0n) {
    throw new CoorwaError(
      "The swap produced no spendable COOK to bridge.",
      `About ${COOKIE_GAS_RESERVE} COOK has to stay behind to pay the bridge transaction's own fee.`,
    );
  }

  ctl.update({ bridgeAmount: rawToUi(toBridge, COOK_DECIMALS) });
  ctl.setStep(i, {
    state: "done",
    signature,
    chain: "cookie",
    detail: `${fmtAmount(rawToUi(gained, COOK_DECIMALS))} COOK received`,
  });
};

// --- Leg 1, sell: xStock -> COOK on Solana -------------------------------------------------------

const sellRwaForCook: LegRunner = async (ctl, ctx, i) => {
  const j = ctl.get();
  if (!j.input.amountRaw) {
    throw new CoorwaError(
      "This sale has no raw amount recorded.",
      "Nothing has been signed. Discard the route and enter the size again - a rebasing token can " +
        "only be spent in the raw units its own account reports.",
    );
  }

  ctl.setStep(i, {
    state: "running",
    detail: `Selling ${fmtAmount(j.input.amount, 8)} ${j.ticker}x for COOK`,
  });

  let signature = await landedSignature(ctx.solanaConn, j.steps[i]?.signature);
  let quoted: number | null = null;

  if (!signature) {
    const leg = await postJson<SolanaLegResponse>("/api/crosschain/solana-swap", {
      ticker: j.ticker,
      // Raw units, not shares. xStocks rebase, so only the holder's token account knows what a
      // displayed balance is worth, and the panel read this figure straight off that account.
      amountRaw: j.input.amountRaw,
      owner: ctx.owner.toBase58(),
      slippageBps: ctx.slippageBps,
      direction: "sell",
    });
    quoted = rawToUi(leg.outAmount, leg.outDecimals);
    signature = await sendAndRecord(
      ctx.solanaConn,
      decodeTx(leg.transactionBase64),
      ctx,
      ctl,
      i,
      "solana",
    );
  }

  const parsed = await fetchParsed(ctx.solanaConn, signature);
  const delta = tokenDelta(parsed, ctx.owner, COOK_SOLANA_MINT, COOK_SOLANA_DECIMALS);
  const measured = delta && delta.ui > 0 ? delta.ui : quoted;

  if (!measured || measured <= 0) {
    throw new CoorwaError(
      "The sale landed, but the COOK it produced could not be read back.",
      "Nothing is lost and nothing was sent twice. Your COOK is in your Solana wallet. Resume the " +
        "route and it will read the amount again without re-signing this leg.",
    );
  }

  // No reserve on this side: Hyperlane charges its interchain gas in SOL here, not out of the COOK.
  ctl.update({ bridgeAmount: round(measured, COOK_SOLANA_DECIMALS) });
  ctl.setStep(i, {
    state: "done",
    signature,
    chain: "solana",
    detail: `${fmtAmount(measured)} COOK on Solana`,
  });
};

// --- Leg 1, LP fees: claim what a position has earned --------------------------------------------

/**
 * Claim a position's fees, then measure both sides of what the claim paid.
 *
 * The pool does not refuse a second claim: it pays whatever accrued in between, which is next to
 * nothing. So the stored signature is what stops a resume claiming twice, and a second claim that
 * did slip through would cost one transaction fee, never anyone's funds.
 *
 * Nothing is measured against a balance read beforehand. The claim transaction's own balances say
 * exactly what it paid, and that also keeps COOK the wallet was already holding out of the payout.
 */
const claimLpFees: LegRunner = async (ctl, ctx, i) => {
  const j = ctl.get();
  const lp = j.lpClaim;
  if (!lp) {
    throw new CoorwaError(
      "This payout names no position to claim from.",
      "Nothing has been signed. Discard it and start again from the LP page.",
    );
  }

  let signature = await landedSignature(ctx.cookieConn, j.steps[i]?.signature);
  if (!signature) {
    ctl.setStep(i, { state: "running", detail: "Reading your position" });
    // Loaded here rather than at the top: the Anchor bundle behind it fails to evaluate during
    // server rendering, and every page with a payout panel imports this file.
    const { buildClaimFees, buildDeps, findUserPositions, loadPool } = await import("./liquidity");
    const deps = buildDeps(ctx.cookieConn);
    const pool = await loadPool(deps, lp.pool);
    const position = (await findUserPositions(deps, ctx.owner, pool.pool)).find(
      (p) => p.position.toBase58() === lp.position,
    );
    if (!position) {
      throw new CoorwaError(
        "This position is no longer in your wallet.",
        "Nothing has been signed. A position belongs to whoever holds its NFT, so only that wallet " +
          "can claim its fees.",
      );
    }

    ctl.setStep(i, { state: "running", detail: "Claiming your fees" });
    const tx = await buildClaimFees({ ctx: pool, owner: ctx.owner, position });
    const { blockhash } = await ctx.cookieConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = ctx.owner;
    signature = await sendAndRecord(ctx.cookieConn, tx, ctx, ctl, i, "cookie");
  }

  const parsed = await fetchParsed(ctx.cookieConn, signature);
  const ownerDelta = cookieNativeLamports(parsed, ctx.owner);
  const wrapped = getAssociatedTokenAddressSync(new PublicKey(COOK_MINT), ctx.owner, true);
  const sold = tokenDelta(parsed, ctx.owner, j.token.mint, j.token.decimals);
  if (!parsed || ownerDelta === null || sold === null) {
    throw new CoorwaError(
      "The fee claim landed, but what it paid could not be read back.",
      "Nothing is lost and nothing was sent twice. The fees are in your Cookie Chain wallet. Resume " +
        "the payout and it will read them again without re-signing this leg.",
    );
  }
  const claimed = lpClaimedCook(ownerDelta, accountLamportsBefore(parsed, wrapped));
  const tokenRaw = sold.raw > 0n ? sold.raw : 0n;

  ctl.update({ lpClaimedLamports: claimed.toString(), sellRaw: tokenRaw.toString() });

  // With no side to sell, this leg hands the bridge its amount itself.
  if (ctl.get().legs[i + 1]?.kind !== "cookie-swap") {
    const reserve = BigInt(uiToRaw(COOKIE_GAS_RESERVE, COOK_DECIMALS));
    const toBridge = lpToBridge(claimed, 0n, reserve);
    if (toBridge <= 0n) throw tooLittleToBridge();
    ctl.update({ bridgeAmount: rawToUi(toBridge, COOK_DECIMALS) });
  }

  const cook = `${fmtAmount(rawToUi(claimed > 0n ? claimed : 0n, COOK_DECIMALS))} COOK`;
  ctl.setStep(i, {
    state: "done",
    signature,
    chain: "cookie",
    detail:
      tokenRaw > 0n
        ? `${fmtAmount(rawToUi(tokenRaw, j.token.decimals))} ${j.token.symbol} and ${cook} claimed`
        : `${cook} claimed`,
  });
};

// --- Leg 1, creator fees: claim what a launchpad pool owes its creator ---------------------------

/**
 * Claim a launchpad pool's creator fees through MomoSwap, then read what the claim paid.
 *
 * The build is checked against MomoSwap's own declaration and against the claim the user asked for
 * before the wallet signs, as on the launch page. Like an LP claim, the pool pays whatever accrued
 * again on a second claim, so the stored signature is what stops a resume claiming twice.
 */
const claimCreatorFees: LegRunner = async (ctl, ctx, i) => {
  const j = ctl.get();
  const claim = j.creatorClaim;
  if (!claim) {
    throw new CoorwaError(
      "This payout names no pool to claim from.",
      "Nothing has been signed. Discard it and start again from the launch page.",
    );
  }

  let signature = await landedSignature(ctx.cookieConn, j.steps[i]?.signature);
  if (!signature) {
    ctl.setStep(i, { state: "running", detail: "Building the claim" });
    const intent = {
      action: "claim-creator-fees" as const,
      wallet: ctx.owner.toBase58(),
      pool: claim.pool,
    };
    const built = await postJson<{
      transactionBase64?: string;
      expectation?: unknown;
      error?: string;
      hint?: string;
    }>("/api/launchpad/trade", intent);
    if (built.error || !built.transactionBase64) {
      throw new CoorwaError(
        built.error ?? "MomoSwap returned no claim transaction.",
        built.hint ?? "Nothing has been signed. Try again in a moment.",
      );
    }
    const { verifyLaunchpadBuild } = await import("./expectation");
    await verifyLaunchpadBuild(built as Parameters<typeof verifyLaunchpadBuild>[0], intent);

    ctl.setStep(i, { state: "running", detail: "Claiming your creator fees" });
    signature = await sendAndRecord(
      ctx.cookieConn,
      decodeTx(built.transactionBase64),
      ctx,
      ctl,
      i,
      "cookie",
    );
  }

  const parsed = await fetchParsed(ctx.cookieConn, signature);
  const ownerDelta = cookieNativeLamports(parsed, ctx.owner);
  if (!parsed || ownerDelta === null) {
    throw new CoorwaError(
      "The claim landed, but what it paid could not be read back.",
      "Nothing is lost and nothing was sent twice. The fees are in your Cookie Chain wallet. Resume " +
        "the payout and it will read them again without re-signing this leg.",
    );
  }
  const wrapped = getAssociatedTokenAddressSync(new PublicKey(COOK_MINT), ctx.owner, true);
  const claimed = lpClaimedCook(ownerDelta, accountLamportsBefore(parsed, wrapped));
  const reserve = BigInt(uiToRaw(COOKIE_GAS_RESERVE, COOK_DECIMALS));
  const toBridge = lpToBridge(claimed, 0n, reserve);
  if (toBridge <= 0n) throw tooLittleToBridge();

  ctl.update({ bridgeAmount: rawToUi(toBridge, COOK_DECIMALS) });
  ctl.setStep(i, {
    state: "done",
    signature,
    chain: "cookie",
    detail: `${fmtAmount(rawToUi(claimed > 0n ? claimed : 0n, COOK_DECIMALS))} COOK claimed`,
  });
};

function tooLittleToBridge(): CoorwaError {
  return new CoorwaError(
    "The fees brought in too little COOK to bridge.",
    `About ${COOKIE_GAS_RESERVE} COOK has to stay behind to pay the bridge transaction's own fee. ` +
      "Whatever was claimed is in your Cookie Chain wallet.",
  );
}

// --- Leg 2: the bridge, either way ---------------------------------------------------------------

const bridgeLeg: LegRunner = async (ctl, ctx, i) => {
  const buy = ctl.get().direction === "buy";
  const sourceConn = buy ? ctx.cookieConn : ctx.solanaConn;
  const sourceDecimals = buy ? COOK_DECIMALS : COOK_SOLANA_DECIMALS;
  const chain: "cookie" | "solana" = buy ? "cookie" : "solana";
  const destLabel = buy ? "Solana" : "Cookie Chain";

  const toBridge = ctl.get().bridgeAmount;
  if (!toBridge || toBridge <= 0) {
    throw new CoorwaError(
      "There is no measured amount to bridge.",
      "The leg before this one has to confirm first. Nothing has been signed.",
    );
  }

  /**
   * The destination balance is read BEFORE dispatching, and frozen the moment it is.
   *
   * Delivery has no receipt to await - a relayer does it, and the only reliable signal is the
   * recipient's balance rising. A baseline taken afterwards would already contain the delivery, so
   * the wait would never finish. That is the case a resumed route hits every single time.
   *
   * The presence of a dispatch signature is what decides it. Before that, the balance is re-read on
   * every attempt: a route that failed its preflight an hour ago and is being retried now must not
   * measure delivery against an hour-old number.
   */
  let signature = await landedSignature(sourceConn, ctl.get().steps[i]?.signature);

  if (!signature) {
    ctl.setStep(i, { state: "running", detail: `Reading your COOK balance on ${destLabel} first` });
    ctl.update({ destBaseline: await destinationCook(ctx, buy) });

    ctl.setStep(i, {
      state: "running",
      detail: `Bridging ${fmtAmount(toBridge)} COOK to ${destLabel}`,
    });

    const bridge = await buildBridgeTransfer({
      direction: buy ? "cookie-to-solana" : "solana-to-cookie",
      cookieConn: ctx.cookieConn,
      solanaConn: ctx.solanaConn,
      sender: ctx.owner,
      recipient: ctx.owner,
      amountRaw: BigInt(uiToRaw(toBridge, sourceDecimals)),
    });

    // The warp route's ata_payer PDA is shared and silently drainable. If the recipient has no COOK
    // account on Solana yet, create it ourselves FIRST, so a failure there costs nothing.
    if (bridge.recipientAtaIx) {
      ctl.setStep(i, { state: "running", detail: "Creating your COOK account on Solana first" });
      const ataTx = new Transaction().add(bridge.recipientAtaIx);
      const { blockhash } = await ctx.solanaConn.getLatestBlockhash("confirmed");
      ataTx.recentBlockhash = blockhash;
      ataTx.feePayer = ctx.owner;
      const signed = await ctx.signTransaction(ataTx);
      const sig = await ctx.solanaConn.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
      await confirm(ctx.solanaConn, sig);
    }

    ctl.setStep(i, { state: "running", detail: "Dispatching over Hyperlane" });
    signature = await sendAndRecord(sourceConn, bridge.transaction, ctx, ctl, i, chain);
  }

  const parsed = await fetchParsed(sourceConn, signature);
  const msgId = messageIdFromLogs(parsed?.meta?.logMessages);
  if (msgId) ctl.update({ messageId: msgId });
  const dispatched = msgId ? `Hyperlane message ${shortAddr(msgId, 8)}` : "Dispatched";

  // When the bridge is the last leg, the user asked for COOK itself, so the route is not finished
  // until it has actually arrived. Otherwise the wait belongs to the leg that spends it.
  if (i === ctl.get().legs.length - 1) {
    ctl.setStep(i, {
      state: "running",
      signature,
      chain,
      detail: `${dispatched}. Waiting for delivery`,
    });
    const delivered = await awaitDelivery(ctl, ctx, i, buy);
    ctl.setStep(i, { state: "done", detail: `${fmtAmount(delivered)} COOK arrived on ${destLabel}` });
    return;
  }

  ctl.setStep(i, { state: "done", signature, chain, detail: dispatched });
};

// --- Leg 3, buy: wait for delivery, then buy the xStock on Solana --------------------------------

const deliverThenBuyRwa: LegRunner = async (ctl, ctx, i) => {
  const j = ctl.get();
  const out = { mint: j.rwaMint, decimals: j.rwaDecimals, symbol: `${j.ticker}x` };

  const existing = await landedSignature(ctx.solanaConn, j.steps[i]?.signature);
  if (existing) {
    await markFinalLeg(ctl, ctx, i, existing, "solana", ctx.solanaConn, out);
    return;
  }

  const delivered = await awaitDelivery(ctl, ctx, i, true);

  ctl.setStep(i, {
    state: "running",
    detail: `Buying ${j.ticker}x with ${fmtAmount(delivered)} COOK`,
  });

  const leg = await postJson<SolanaLegResponse>("/api/crosschain/solana-swap", {
    ticker: j.ticker,
    amount: delivered,
    owner: ctx.owner.toBase58(),
    slippageBps: ctx.slippageBps,
    direction: "buy",
  });

  const signature = await sendAndRecord(
    ctx.solanaConn,
    decodeTx(leg.transactionBase64),
    ctx,
    ctl,
    i,
    "solana",
  );

  await markFinalLeg(ctl, ctx, i, signature, "solana", ctx.solanaConn, {
    ...out,
    quoted: rawToUi(leg.outAmount, leg.outDecimals),
  });
};

// --- Leg 3, sell: wait for delivery, then buy the token on Cookie Chain --------------------------

const deliverThenBuyToken: LegRunner = async (ctl, ctx, i) => {
  const j = ctl.get();
  const out = { mint: j.token.mint, decimals: j.token.decimals, symbol: j.token.symbol };

  const existing = await landedSignature(ctx.cookieConn, j.steps[i]?.signature);
  if (existing) {
    await markFinalLeg(ctl, ctx, i, existing, "cookie", ctx.cookieConn, out);
    return;
  }

  const delivered = await awaitDelivery(ctl, ctx, i, false);

  // COOK is the gas token on this side, so the swap cannot spend the whole delivery.
  const spendable = round(delivered - COOKIE_GAS_RESERVE, COOK_DECIMALS);
  if (spendable <= 0) {
    throw new CoorwaError(
      `Only ${fmtAmount(delivered)} COOK arrived, which is not enough to pay for the final swap.`,
      `About ${COOKIE_GAS_RESERVE} COOK has to stay behind for the transaction fee. The COOK is in ` +
        "your Cookie Chain wallet and can be spent by hand.",
    );
  }

  ctl.setStep(i, {
    state: "running",
    detail: `Buying ${j.token.symbol} with ${fmtAmount(spendable)} COOK`,
  });

  const built = await postJson<{ transactionBase64: string }>("/api/swap/build", {
    aggregator: "cookiebox",
    owner: ctx.owner.toBase58(),
    inputMint: COOK_MINT,
    outputMint: j.token.mint,
    amount: uiToRaw(spendable, COOK_DECIMALS),
    slippageBps: ctx.slippageBps,
  });

  const signature = await sendAndRecord(
    ctx.cookieConn,
    decodeTx(built.transactionBase64),
    ctx,
    ctl,
    i,
    "cookie",
  );
  reportSwap(ctx, j, signature, "buy");

  await markFinalLeg(ctl, ctx, i, signature, "cookie", ctx.cookieConn, out);
};

// --- Shared leg machinery ------------------------------------------------------------------------

interface SolanaLegResponse {
  transactionBase64: string;
  outAmount: string;
  outDecimals: number;
}

/**
 * Close out the final leg with what the user actually received, read from the transaction rather
 * than from the quote that predicted it. Falls back to the quote when the RPC will not answer.
 */
async function markFinalLeg(
  ctl: Ctl,
  ctx: RunContext,
  i: number,
  signature: string,
  chain: "cookie" | "solana",
  conn: Connection,
  out: { mint: string; decimals: number; symbol: string; quoted?: number },
): Promise<void> {
  const parsed = await fetchParsed(conn, signature);
  const delta = tokenDelta(parsed, ctx.owner, out.mint, out.decimals);
  const received = delta && delta.ui > 0 ? delta.ui : out.quoted;

  ctl.setStep(i, {
    state: "done",
    signature,
    chain,
    detail: received
      ? `${fmtAmount(received, 8)} ${out.symbol} in your wallet`
      : `${out.symbol} received`,
  });
}

/**
 * Wait for the bridged COOK to show up on the destination, then report what arrived.
 *
 * Measured against the baseline stored before dispatch, which is what lets this survive a page
 * reload. Capped at what was sent, so a resumed route can never sweep COOK the user happened to be
 * holding for some other reason.
 */
async function awaitDelivery(ctl: Ctl, ctx: RunContext, i: number, buy: boolean): Promise<number> {
  const j = ctl.get();
  const expected = j.bridgeAmount ?? 0;
  const baseline = j.destBaseline ?? 0;
  const destLabel = buy ? "Solana" : "Cookie Chain";
  const started = Date.now();

  while (Date.now() - started < DELIVERY_TIMEOUT_MS) {
    let gained = 0;
    try {
      gained = (await destinationCook(ctx, buy)) - baseline;
    } catch {
      // A throttled public RPC is expected here. Keep waiting rather than failing a live transfer.
    }

    if (gained >= expected * DELIVERY_TOLERANCE) {
      return round(Math.min(gained, expected), buy ? COOK_SOLANA_DECIMALS : COOK_DECIMALS);
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    ctl.setStep(i, {
      state: "running",
      detail: `Waiting for the relayer to deliver on ${destLabel} (${elapsed}s)`,
    });
    await sleep(DELIVERY_POLL_MS);
  }

  throw new CoorwaError(
    `The bridge has not delivered on ${destLabel} within 15 minutes.`,
    "Your COOK is not lost. It is locked in the warp route and will be released when a relayer " +
      "picks the message up. Come back to this panel and press Resume - it remembers where the " +
      "route stopped and carries on from there without re-signing anything.",
  );
}

/** The recipient's COOK balance on the destination chain, as a UI amount. */
async function destinationCook(ctx: RunContext, buy: boolean): Promise<number> {
  if (!buy) {
    // Cookie Chain: COOK is the native token, so this is simply the lamport balance.
    const lamports = await ctx.cookieConn.getBalance(ctx.owner, "confirmed");
    return lamports / 10 ** COOK_DECIMALS;
  }
  const mint = new PublicKey(COOK_SOLANA_MINT);
  const accounts = await ctx.solanaConn.getParsedTokenAccountsByOwner(ctx.owner, { mint });
  return accounts.value.reduce(
    (sum, a) => sum + (a.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0),
    0,
  );
}

/**
 * Sign, send, record the signature, then confirm - in that order.
 *
 * The signature is written to the journey the moment the send returns, before confirmation. On a
 * throttled RPC a confirmation can time out on a transaction that landed perfectly well, and
 * without the signature stored a resume would have no way to tell that from a transaction that
 * never went anywhere. It would send it again.
 */
async function sendAndRecord(
  conn: Connection,
  tx: VersionedTransaction | Transaction,
  ctx: RunContext,
  ctl: Ctl,
  i: number,
  chain: "cookie" | "solana",
): Promise<string> {
  await simulate(conn, tx);

  const signed = await ctx.signTransaction(tx);
  const raw =
    signed instanceof VersionedTransaction ? signed.serialize() : signed.serialize();
  const signature = await conn.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  ctl.setStep(i, { signature, chain });

  await confirm(conn, signature);
  return signature;
}

async function confirm(conn: Connection, signature: string): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const res = await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (res.value.err) {
    throw new CoorwaError(`The transaction failed on chain: ${JSON.stringify(res.value.err)}`);
  }
}

/**
 * Did this signature already succeed? The question a resume has to ask before re-sending.
 *
 * Three answers, not two, and the third is the important one. A retry does not re-send the same
 * bytes - the aggregator builds a fresh transaction with a fresh blockhash - so "I could not check"
 * must never be rounded down to "it did not happen". That would sell the user's tokens twice.
 *
 *   landed   confirmed on chain without error - skip this leg
 *   missing  never landed, or landed and failed - safe to send
 *   unknown  the RPC would not answer, or the transaction is still in flight - send nothing
 */
type LegStatus = "landed" | "missing" | "unknown";

async function legStatus(conn: Connection, signature: string): Promise<LegStatus> {
  try {
    const res = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = res.value[0];
    // Not found anywhere, including history: the transaction was dropped and never executed.
    if (!status) return "missing";
    // It executed and reverted, so the swap did not happen. Sending again is the right move.
    if (status.err) return "missing";
    if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
      return "landed";
    }
    // Processed but not yet confirmed. It is still in flight; a second send would race it.
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The signature to reuse for this leg, or null when it still has to be sent.
 *
 * Throws rather than guessing when the answer is unknown, because the only safe thing to do with
 * an unknown signature is to leave it alone.
 */
async function landedSignature(
  conn: Connection,
  signature: string | undefined,
): Promise<string | null> {
  if (!signature) return null;

  const status = await legStatus(conn, signature);
  if (status === "landed") return signature;
  if (status === "missing") return null;

  throw new CoorwaError(
    "This leg was already signed once and its outcome cannot be read back yet.",
    "Nothing has been sent a second time. The transaction is either still in flight or the RPC is " +
      "not answering. Wait a few seconds and press Resume again - re-sending blind could execute " +
      "the same trade twice.",
  );
}

// --- Reading what actually happened ---------------------------------------------------------------

/** Fetch a confirmed transaction, allowing for an RPC that has not caught up with its own vote. */
async function fetchParsed(
  conn: Connection,
  signature: string,
  attempts = 3,
): Promise<ParsedTransactionWithMeta | null> {
  for (let n = 0; n < attempts; n++) {
    try {
      const tx = await conn.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) return tx;
    } catch {
      // Fall through to the retry.
    }
    if (n < attempts - 1) await sleep(1_500);
  }
  return null;
}

/**
 * Change in the owner's native COOK balance on Cookie Chain, in lamports, net of the fee they paid.
 * Null when it cannot be read.
 */
function cookieNativeLamports(
  tx: ParsedTransactionWithMeta | null,
  owner: PublicKey,
): bigint | null {
  if (!tx?.meta) return null;
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(owner));
  if (i < 0) return null;
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}

/** Lamports an account held before the transaction, or 0 when it did not exist or is not in it. */
function accountLamportsBefore(tx: ParsedTransactionWithMeta, account: PublicKey): bigint {
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(account));
  return i < 0 ? 0n : BigInt(tx.meta?.preBalances[i] ?? 0);
}

/**
 * Change in the owner's balance of one token.
 *
 * Both figures come back because they are not interchangeable here. xStocks carry
 * `scaledUiAmountConfig`, so `raw` is what a program moves and `ui` is what the holder sees, and
 * the two differ by a multiplier that changes on dividends and splits. Spend `raw`, display `ui`.
 */
function tokenDelta(
  tx: ParsedTransactionWithMeta | null,
  owner: PublicKey,
  mint: string,
  decimals: number,
): { raw: bigint; ui: number } | null {
  if (!tx?.meta) return null;
  const meta = tx.meta;
  const address = owner.toBase58();

  const total = (rows: typeof meta.preTokenBalances) => {
    let raw = 0n;
    let ui = 0;
    for (const b of rows ?? []) {
      if (b.mint !== mint || b.owner !== address) continue;
      raw += BigInt(b.uiTokenAmount.amount);
      ui += b.uiTokenAmount.uiAmount ?? rawToUi(b.uiTokenAmount.amount, decimals);
    }
    return { raw, ui };
  };

  const pre = total(meta.preTokenBalances);
  const post = total(meta.postTokenBalances);
  return { raw: post.raw - pre.raw, ui: post.ui - pre.ui };
}

// --- Small helpers --------------------------------------------------------------------------------

/**
 * Report a Cookie Chain swap leg for cashback, as the terminal's swap panel does for its own trades.
 *
 * The fee it paid is re-read from the chain by the server, so this sends nothing that has to be
 * believed. A settlement names its pair, so the trade also counts towards that pair's listing fees;
 * a payout is not trading any pair and names none. Sent again on a resume, which the unique
 * signature makes harmless, and a failure costs the record, never the route.
 */
function reportSwap(ctx: RunContext, j: Journey, signature: string, side: "buy" | "sell"): void {
  const first = j.legs[0]?.kind;
  const payout = first === "lp-claim" || first === "creator-claim";
  void fetch("/api/rewards/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      signature,
      wallet: ctx.owner.toBase58(),
      source: "swap",
      mint: j.token.mint,
      ticker: payout ? undefined : j.ticker,
      symbol: j.token.symbol,
      side,
      // Derived server-side from the fee the transaction paid.
      valueUsd: 0,
      feeUsd: 0,
      chain: "cookie",
    }),
  }).catch(() => undefined);
}

async function getJson<T>(url: string): Promise<T> {
  const json = await fetch(url).then((r) => r.json());
  if (json?.error) throw new CoorwaError(json.error, json.hint);
  return json as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json?.error) throw new CoorwaError(json.error, json.hint);
  return json as T;
}

/** The message the user reads after a failure: the reason, plus what to do about it. */
function describe(e: unknown): string {
  const hint = e instanceof CoorwaError ? e.hint : undefined;
  const message = explainError(e);
  return hint ? `${message} ${hint}` : message;
}

function round(n: number, decimals: number): number {
  return Number(n.toFixed(decimals));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
