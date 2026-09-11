"use client";

/**
 * The executor for a cross-chain route, in both directions, resumable from the middle.
 *
 *   buy     TOKEN --[Cookie agg]--> COOK --[Hyperlane]--> COOK (Solana) --[Jupiter]--> xSTOCK
 *   sell    xSTOCK --[Jupiter]--> COOK (Solana) --[Hyperlane]--> COOK --[Cookie agg]--> TOKEN
 *   payout  vault --[claim]--> COOK --[Hyperlane]--> COOK (Solana) --[Jupiter]--> xSTOCK
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
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { COOK_DECIMALS, COOK_MINT, COOK_SOLANA_DECIMALS, COOK_SOLANA_MINT } from "./config";
import { buildBridgeTransfer, messageIdFromLogs } from "./bridge";
import { claimInstructions, claimStatusPda, epochPda, vaultPda } from "./vault";
import { claimedToBridge, proofBytes } from "./payout";
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
    if (kind === "claim") return claimCashback;
    if (kind === "bridge") return bridgeLeg;
    if (j.direction === "buy") return kind === "cookie-swap" ? sellTokenForCook : deliverThenBuyRwa;
    return kind === "solana-swap" ? sellRwaForCook : deliverThenBuyToken;
  });
}

// --- Leg 1, buy: TOKEN -> COOK on Cookie Chain ---------------------------------------------------

const sellTokenForCook: LegRunner = async (ctl, ctx, i) => {
  const j = ctl.get();
  ctl.setStep(i, {
    state: "running",
    detail: `Selling ${fmtAmount(j.input.amount)} ${j.token.symbol} for COOK`,
  });

  let signature = await landedSignature(ctx.cookieConn, j.steps[i]?.signature);
  if (!signature) {
    const built = await postJson<{ transactionBase64: string }>("/api/swap/build", {
      aggregator: "cookiebox",
      owner: ctx.owner.toBase58(),
      inputMint: j.token.mint,
      outputMint: COOK_MINT,
      amount: uiToRaw(j.input.amount, j.token.decimals),
      slippageBps: ctx.slippageBps,
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
  const parsed = await fetchParsed(ctx.cookieConn, signature);
  const gained = cookieNativeDelta(parsed, ctx.owner);
  if (gained === null) {
    throw new CoorwaError(
      "The swap landed, but its result could not be read back.",
      "Nothing is lost and nothing was sent twice. Your COOK is in your Cookie Chain wallet. " +
        "Resume the route and it will read the amount again without re-signing this leg.",
    );
  }

  const toBridge = round(gained - COOKIE_GAS_RESERVE, COOK_DECIMALS);
  if (toBridge <= 0) {
    throw new CoorwaError(
      "The swap produced no spendable COOK to bridge.",
      `About ${COOKIE_GAS_RESERVE} COOK has to stay behind to pay the bridge transaction's own fee.`,
    );
  }

  ctl.update({ bridgeAmount: toBridge });
  ctl.setStep(i, {
    state: "done",
    signature,
    chain: "cookie",
    detail: `${fmtAmount(gained)} COOK received`,
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

// --- Leg 1, payout: cashback out of the vault ----------------------------------------------------

/**
 * Claim every open epoch as native COOK, then measure what came in.
 *
 * Resuming this leg is safe because of the vault rather than because of anything stored here: the
 * first claim of an epoch writes a claim record and the program refuses every later attempt. So
 * each epoch is looked up by that record before anything is sent, and one that already paid is
 * skipped. A claim still in flight when the record is read gets sent again, and then one of the two
 * fails on chain and costs its fee, never a second payment.
 *
 * The vault pays wrapped COOK and the bridge takes native, so each claim also closes the wrapped
 * account in the same transaction, which unwraps it.
 */
const claimCashback: LegRunner = async (ctl, ctx, i) => {
  const claims = ctl.get().claims ?? [];
  if (claims.length === 0) {
    throw new CoorwaError(
      "This payout has nothing to claim.",
      "Nothing has been signed. Discard it and start again from the rewards page.",
    );
  }

  // Frozen once the first claim is sent, for the reason the bridge freezes its destination
  // baseline: a balance read afterwards would already contain the claims it is meant to measure.
  if (!ctl.get().steps[i]?.signature) {
    ctl.setStep(i, { state: "running", detail: "Reading your COOK balance first" });
    ctl.update({ claimBaseline: await ctx.cookieConn.getBalance(ctx.owner, "confirmed") });
  }

  const mint = new PublicKey(COOK_MINT);
  const vault = vaultPda(mint);
  const wrapped = getAssociatedTokenAddressSync(mint, ctx.owner);

  for (const c of claims) {
    const record = claimStatusPda(epochPda(vault, BigInt(c.epoch)), ctx.owner);
    if (await ctx.cookieConn.getAccountInfo(record, "confirmed")) continue;

    ctl.setStep(i, { state: "running", detail: `Claiming epoch #${c.epoch}` });
    const tx = new Transaction().add(
      ...claimInstructions({
        claimant: ctx.owner,
        mint,
        index: BigInt(c.epoch),
        amount: BigInt(c.amountRaw),
        proof: proofBytes(c.proof),
      }),
      createCloseAccountInstruction(wrapped, ctx.owner, ctx.owner),
    );
    const { blockhash } = await ctx.cookieConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = ctx.owner;
    const signature = await sendAndRecord(ctx.cookieConn, tx, ctx, ctl, i, "cookie");

    // Only the link to the transaction depends on this landing. The claim record is the truth.
    void fetch("/api/cashback/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature, wallet: ctx.owner.toBase58(), epoch: c.epoch }),
    }).catch(() => undefined);
  }

  const baseline = ctl.get().claimBaseline;
  if (baseline === undefined) {
    throw new CoorwaError(
      "This payout has no balance to measure its claims against.",
      "Whatever was claimed is in your Cookie Chain wallet as COOK. Discard the payout; the COOK " +
        "can be bridged by hand from any pair's settlement panel.",
    );
  }
  const now = await ctx.cookieConn.getBalance(ctx.owner, "confirmed");
  const gained = BigInt(now) - BigInt(baseline);
  const owed = claims.reduce((sum, c) => sum + BigInt(c.amountRaw), 0n);
  const reserve = BigInt(uiToRaw(COOKIE_GAS_RESERVE, COOK_DECIMALS));
  const toBridge = claimedToBridge(gained, owed, reserve);

  if (toBridge <= 0n) {
    throw new CoorwaError(
      "The claims brought in too little COOK to bridge.",
      `About ${COOKIE_GAS_RESERVE} COOK has to stay behind to pay the bridge transaction's own fee. ` +
        "Whatever was claimed is in your Cookie Chain wallet.",
    );
  }

  ctl.update({ bridgeAmount: rawToUi(toBridge, COOK_DECIMALS) });
  ctl.setStep(i, {
    state: "done",
    chain: "cookie",
    detail: `${fmtAmount(rawToUi(gained < owed ? gained : owed, COOK_DECIMALS))} COOK claimed`,
  });
};

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
 * Change in the owner's native COOK balance on Cookie Chain, net of the fee they paid. Null when it
 * cannot be read. Cookie Chain specific: it divides by COOK's 9 native decimals.
 */
function cookieNativeDelta(
  tx: ParsedTransactionWithMeta | null,
  owner: PublicKey,
): number | null {
  if (!tx?.meta) return null;
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(owner));
  if (i < 0) return null;
  return (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 10 ** COOK_DECIMALS;
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
