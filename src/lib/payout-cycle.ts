/**
 * The daily payout run: from COOK in the operator wallet to each holder's pair asset on Solana.
 *
 * A run is a row in `payout_cycles` that advances one status per call, because it spans two chains,
 * a bridge that takes minutes, and more transactions than one request should hold open:
 *
 *   allocated  the ledger has shared the pools out and queued what is due (`rewards-ledger.ts`)
 *   bridging   the operator's COOK is on its way to Solana over Hyperlane
 *   bridged    it arrived; Jupiter swaps it into SOL for the run's costs and into each pair's asset
 *   sending    the assets go out to holders and creators, a few wallets per transaction
 *   done       and what the run really cost in SOL is written down
 *
 * Every transaction is recorded before it is sent, so a call that dies mid-step leaves enough behind
 * for the next one to check what landed instead of paying twice. Called every few minutes by the
 * scheduler through the sample endpoint; most calls find nothing due and return at once.
 *
 * Custodial by design, like StonkFun's payouts: the day's fees sit in the operator wallet until the
 * run pays them out. Server only.
 */
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Keypair,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { buildBridgeTransfer, scaleRaw } from "./bridge";
import { fetchSolUsd, jupQuote, jupSwapTx } from "./jupiter";
import { fetchCookPriceUsd } from "./cookiescan";
import { rwaByTicker } from "./rwa";
import { operatorKeypair } from "./operator";
import { allocateRun, lineAmounts, nextRunDueAt, splitRaw } from "./rewards-ledger";
import {
  COOKIE_RPC_URL,
  COOK_DECIMALS,
  COOK_SOLANA_DECIMALS,
  COOK_SOLANA_MINT,
  OPERATOR_COOK_RESERVE,
  OPERATOR_SOL_FLOOR,
  PAYOUT_SLIPPAGE_BPS,
  serverSolanaRpcUrl,
  WSOL_MINT,
} from "./config";

type Cycle = typeof schema.payoutCycles.$inferSelect;

/** Rent for an xStock token account on Solana, measured on 2026-09-11 (179 bytes). */
const RWA_ACCOUNT_RENT = 1_944_231;
/** A generous per-transaction fee allowance, priority fee included. */
const TX_FEE_LAMPORTS = 20_000;
/** What a Jupiter swap may cost in fees, since routes set their own compute and priority. */
const SWAP_FEE_LAMPORTS = 200_000;
/** Wallets paid per transaction: two instructions each, well inside the size limit. */
const SEND_BATCH = 5;
/** A step waiting on a transaction gives up on it after this long and sends again. */
const DROPPED_AFTER_MS = 3 * 60 * 1000;
/** Two calls never work on one run at once: a call claims it for this long. */
const LEASE_MS = 90 * 1000;
/** How long one call keeps sending before it leaves the rest to the next call. */
const SEND_BUDGET_MS = 25 * 1000;
/** Steps that may fail in a row before the run is given up on, about an hour of calls. */
export const MAX_CYCLE_ATTEMPTS = 10;
/**
 * Sends a line may be part of that do not land before the wallet is left unpaid. Lower than the
 * run's own limit on purpose: the run has to outlive the wallet that is holding it up, or it gives
 * up first and the next run walks into the same wallet again.
 */
export const MAX_LINE_ATTEMPTS = 5;

const UNITS = 10n ** BigInt(COOK_DECIMALS);

export interface PayoutStepResult {
  action: string;
  cycleId?: number;
  detail?: string;
}

function requireDb() {
  if (!db) throw new Error("payouts need DATABASE_URL");
  return db;
}

const cookieConn = () => new Connection(COOKIE_RPC_URL, "confirmed");
const solanaConn = () => new Connection(serverSolanaRpcUrl(), "confirmed");

const token22Ata = (mint: string | PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, TOKEN_2022_PROGRAM_ID);

async function update(id: number, set: Partial<typeof schema.payoutCycles.$inferInsert>) {
  await requireDb()
    .update(schema.payoutCycles)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(schema.payoutCycles.id, id));
}

/** Claim a run for this call, or learn that another call has it. */
async function lease(id: number, now: Date): Promise<boolean> {
  const rows = await requireDb()
    .update(schema.payoutCycles)
    .set({ updatedAt: now })
    .where(
      and(
        eq(schema.payoutCycles.id, id),
        lt(schema.payoutCycles.updatedAt, new Date(now.getTime() - LEASE_MS)),
      ),
    )
    .returning({ id: schema.payoutCycles.id });
  return rows.length > 0;
}

/** Advance the open run by one step, or start a run if one is due. */
export async function runPayoutStep(now = new Date()): Promise<PayoutStepResult> {
  const signer = operatorKeypair();
  if (!signer) {
    return { action: "off", detail: "no COORWA_OPERATOR_KEY matching NEXT_PUBLIC_COORWA_OPERATOR" };
  }
  const conn = requireDb();

  const [open] = await conn
    .select()
    .from(schema.payoutCycles)
    .where(inArray(schema.payoutCycles.status, ["allocated", "bridging", "bridged", "sending"]))
    .orderBy(asc(schema.payoutCycles.id))
    .limit(1);

  if (!open) {
    const due = await nextRunDueAt();
    if (!due) return { action: "idle", detail: "nothing sampled since the last run" };
    if (due > now) return { action: "idle", detail: `next run due ${due.toISOString()}` };
    const cookPriceUsd = await fetchCookPriceUsd();
    if (!cookPriceUsd) return { action: "idle", detail: "no COOK price" };
    const run = await allocateRun(now, cookPriceUsd);
    // Another call held the allocation lock and wrote the run this one was about to write.
    if (run.cycleId === 0) return { action: "busy", detail: "another call allocated this run" };
    return {
      action: "allocated",
      cycleId: run.cycleId,
      detail: `${run.lines} lines, $${run.totalUsd.toFixed(4)} due now`,
    };
  }

  if (!(await lease(open.id, now))) return { action: "busy", cycleId: open.id };

  try {
    const detail =
      open.status === "allocated"
        ? await bridge(open, signer)
        : open.status === "bridging"
          ? await awaitBridge(open, signer, now)
          : open.status === "bridged"
            ? await swap(open, signer)
            : await send(open, signer, now);
    // The step got through, so whatever failed before it was a bad minute rather than a dead run.
    if (open.attempts > 0) await update(open.id, { attempts: 0 });
    return { action: open.status, cycleId: open.id, detail };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const attempts = open.attempts + 1;
    if (attempts >= MAX_CYCLE_ATTEMPTS) {
      await giveUp(open, message);
      return { action: "stuck", cycleId: open.id, detail: message };
    }
    await update(open.id, { note: message.slice(0, 500), attempts });
    return { action: "error", cycleId: open.id, detail: message };
  }
}

/**
 * Stop a run that cannot be finished, so the next one is not held up behind it.
 *
 * A step always takes the oldest run still open, so a bridge that never arrives, a route that keeps
 * dying or any other step that fails every time would mean nobody is ever paid again. What the run
 * had queued goes back to waiting and a later run shares it out again; what it already sent stays
 * sent, and the reason it stopped stays in `note` for the operator.
 */
async function giveUp(cycle: Cycle, reason: string) {
  const { payoutLines } = schema;
  await requireDb()
    .update(payoutLines)
    .set({ status: "allocated", paidIn: null, signature: null, assetRaw: null, attempts: 0 })
    .where(and(eq(payoutLines.paidIn, cycle.id), eq(payoutLines.status, "queued")));
  await update(cycle.id, { status: "stuck", note: reason.slice(0, 500), stepAt: null });
}

// --- allocated: cost budget and bridge ---------------------------------------------------------------

/** The run's queued lines, with the asset each is paid in. */
async function queuedLines(cycleId: number) {
  return requireDb()
    .select()
    .from(schema.payoutLines)
    .where(eq(schema.payoutLines.paidIn, cycleId));
}

/**
 * What the run will spend on Solana, in USD: a token account for every recipient and for the
 * operator that does not have one yet, a fee per send and per swap. SOL the operator already holds
 * above its floor is used first, so a run only buys what it is short of.
 */
async function costBudgetUsd(cycleId: number, operator: PublicKey): Promise<number> {
  const sol = solanaConn();
  const lines = await queuedLines(cycleId);
  const recipients = new Map<string, PublicKey>();
  const tickers = new Set<string>();
  for (const l of lines) {
    const asset = rwaByTicker(l.ticker);
    if (!asset) continue;
    tickers.add(asset.ticker);
    recipients.set(`${l.wallet}|${asset.mint}`, token22Ata(asset.mint, new PublicKey(l.wallet)));
  }
  for (const t of tickers) {
    const asset = rwaByTicker(t)!;
    recipients.set(`operator|${asset.mint}`, token22Ata(asset.mint, operator));
  }

  const accounts = [...recipients.values()];
  let missing = 0;
  for (let i = 0; i < accounts.length; i += 100) {
    const infos = await sol.getMultipleAccountsInfo(accounts.slice(i, i + 100), "confirmed");
    missing += infos.filter((x) => x === null).length;
  }

  const wallets = new Set(lines.map((l) => `${l.wallet}|${l.ticker}`)).size;
  const needed =
    missing * RWA_ACCOUNT_RENT +
    Math.ceil(wallets / SEND_BATCH) * TX_FEE_LAMPORTS +
    (tickers.size + 1) * SWAP_FEE_LAMPORTS;
  const spare = Math.max(0, (await sol.getBalance(operator, "confirmed")) - OPERATOR_SOL_FLOOR * 1e9);
  const toBuy = Math.max(0, needed - spare);
  if (toBuy === 0) return 0;

  const solUsd = await fetchSolUsd();
  if (!solUsd) throw new Error("no SOL price, so the run's costs cannot be budgeted");
  return (toBuy / 1e9) * solUsd;
}

async function bridge(cycle: Cycle, signer: Keypair): Promise<string> {
  const operator = signer.publicKey;
  const cookie = cookieConn();
  const sol = solanaConn();

  const budgetUsd = await costBudgetUsd(cycle.id, operator);
  // A little over, because Jupiter's price is not the Cookie Chain price the run was valued at.
  const needRaw = BigInt(
    Math.ceil(((cycle.totalUsd + budgetUsd) / cycle.cookPriceUsd) * 1.03 * Number(UNITS)),
  );

  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, operator);
  let wrappedRaw = 0n;
  try {
    wrappedRaw = BigInt((await cookie.getTokenAccountBalance(wrapped, "confirmed")).value.amount);
  } catch {
    // No wrapped account: nothing was paid to the operator as wCOOK yet.
  }
  const native = BigInt(await cookie.getBalance(operator, "confirmed"));
  let amount = native + wrappedRaw - BigInt(OPERATOR_COOK_RESERVE) * UNITS;
  if (amount > needRaw) amount = needRaw;
  // Solana's COOK has three fewer decimals, and the bridge would strand the difference.
  amount -= amount % 10n ** BigInt(COOK_DECIMALS - COOK_SOLANA_DECIMALS);
  if (amount <= 0n) {
    await update(cycle.id, { note: "the operator holds no COOK above its reserve" });
    return "waiting for COOK";
  }

  // The operator's COOK account on Solana has to exist before the bridge can deliver into it.
  const cookAccount = token22Ata(COOK_SOLANA_MINT, operator);
  if (!(await sol.getAccountInfo(cookAccount, "confirmed"))) {
    const create = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        operator,
        cookAccount,
        operator,
        new PublicKey(COOK_SOLANA_MINT),
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    const latest = await sol.getLatestBlockhash("confirmed");
    create.recentBlockhash = latest.blockhash;
    create.feePayer = operator;
    create.sign(signer);
    const sig = await sol.sendRawTransaction(create.serialize());
    await sol.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }
  const before = BigInt((await sol.getTokenAccountBalance(cookAccount, "confirmed")).value.amount);

  const built = await buildBridgeTransfer({
    direction: "cookie-to-solana",
    cookieConn: cookie,
    solanaConn: sol,
    sender: operator,
    recipient: operator,
    amountRaw: amount,
  });

  // Referral fees arrive as wrapped COOK; closing the account in the same transaction unwraps them
  // in time for the bridge to take them.
  const tx = new Transaction();
  if (wrappedRaw > 0n) tx.add(createCloseAccountInstruction(wrapped, operator, operator));
  tx.add(...built.transaction.instructions);
  tx.recentBlockhash = (await cookie.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = operator;
  tx.sign(signer, built.uniqueMessage);
  const signature = bs58.encode(tx.signature!);

  await update(cycle.id, {
    status: "bridging",
    bridgeSignature: signature,
    bridgeCookRaw: amount,
    solanaCookBefore: before,
    costBudgetUsd: budgetUsd,
    stepAt: new Date(),
    note: null,
  });
  await cookie.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  return `bridging ${Number(amount) / Number(UNITS)} COOK`;
}

// --- bridging: wait for delivery ---------------------------------------------------------------------

async function awaitBridge(cycle: Cycle, signer: Keypair, now: Date): Promise<string> {
  const cookie = cookieConn();
  const sol = solanaConn();
  const status = (
    await cookie.getSignatureStatus(cycle.bridgeSignature!, { searchTransactionHistory: true })
  ).value;

  if (status?.err) {
    await update(cycle.id, {
      status: "allocated",
      bridgeSignature: null,
      stepAt: null,
      note: `the bridge transaction failed: ${JSON.stringify(status.err)}`,
    });
    return "bridge failed, will retry";
  }
  if (!status) {
    if (cycle.stepAt && now.getTime() - cycle.stepAt.getTime() > DROPPED_AFTER_MS) {
      await update(cycle.id, {
        status: "allocated",
        bridgeSignature: null,
        stepAt: null,
        note: "the bridge transaction never landed, sending again",
      });
      return "bridge dropped, will retry";
    }
    return "waiting for the bridge transaction";
  }

  const cookAccount = token22Ata(COOK_SOLANA_MINT, signer.publicKey);
  const balance = BigInt((await sol.getTokenAccountBalance(cookAccount, "confirmed")).value.amount);
  const expected = scaleRaw(cycle.bridgeCookRaw!, COOK_DECIMALS, COOK_SOLANA_DECIMALS);
  if (balance - (cycle.solanaCookBefore ?? 0n) < (expected * 999n) / 1000n) {
    await update(cycle.id, { note: "waiting for Hyperlane to deliver on Solana" });
    return "waiting for delivery";
  }

  await update(cycle.id, {
    status: "bridged",
    solBefore: BigInt(await sol.getBalance(signer.publicKey, "confirmed")),
    stepAt: null,
    note: null,
  });
  return "delivered";
}

// --- bridged: swap into SOL and the pair assets ---------------------------------------------------------

/** What a swap delivered to the operator, read from the confirmed transaction. */
function received(tx: VersionedTransactionResponse, operator: string, ticker: string): bigint {
  if (ticker === "SOL") {
    const pre = tx.meta?.preBalances?.[0] ?? 0;
    const post = tx.meta?.postBalances?.[0] ?? 0;
    return BigInt(post - pre + (tx.meta?.fee ?? 0));
  }
  const mint = rwaByTicker(ticker)!.mint;
  const amount = (
    list: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] | null | undefined,
  ) => BigInt(list?.find((b) => b.owner === operator && b.mint === mint)?.uiTokenAmount.amount ?? "0");
  return amount(tx.meta?.postTokenBalances) - amount(tx.meta?.preTokenBalances);
}

async function swap(cycle: Cycle, signer: Keypair): Promise<string> {
  const conn = requireDb();
  const sol = solanaConn();
  const operator = signer.publicKey.toBase58();

  const lines = await queuedLines(cycle.id);
  const usdByTicker = new Map<string, number>();
  for (const l of lines) usdByTicker.set(l.ticker, (usdByTicker.get(l.ticker) ?? 0) + l.amountUsd);

  const cookAccount = token22Ata(COOK_SOLANA_MINT, signer.publicKey);
  const balance = BigInt((await sol.getTokenAccountBalance(cookAccount, "confirmed")).value.amount);
  const bridged = scaleRaw(cycle.bridgeCookRaw!, COOK_DECIMALS, COOK_SOLANA_DECIMALS);
  const spend = balance < bridged ? balance : bridged;

  const plan = [
    { key: "SOL", usd: cycle.costBudgetUsd },
    ...[...usdByTicker].map(([key, usd]) => ({ key, usd })),
  ];
  const portions = splitRaw(spend, plan);
  const done = await conn
    .select()
    .from(schema.payoutSwaps)
    .where(eq(schema.payoutSwaps.cycleId, cycle.id));

  for (const { key: ticker } of plan) {
    const portion = portions.get(ticker) ?? 0n;
    if (portion <= 0n) continue;
    const existing = done.find((s) => s.ticker === ticker);
    if (existing?.assetRaw != null) continue;

    if (existing) {
      const tx = await sol.getTransaction(existing.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx && !tx.meta?.err) {
        await conn
          .update(schema.payoutSwaps)
          .set({ assetRaw: received(tx, operator, ticker) })
          .where(eq(schema.payoutSwaps.id, existing.id));
        continue;
      }
      if (!tx && Date.now() - existing.createdAt.getTime() < DROPPED_AFTER_MS) {
        return `waiting for the ${ticker} swap`;
      }
      await conn.delete(schema.payoutSwaps).where(eq(schema.payoutSwaps.id, existing.id));
    }

    const quote = await jupQuote({
      inputMint: COOK_SOLANA_MINT,
      outputMint: ticker === "SOL" ? WSOL_MINT : rwaByTicker(ticker)!.mint,
      amount: portion.toString(),
      slippageBps: PAYOUT_SLIPPAGE_BPS,
    });
    const built = await jupSwapTx({ quoteResponse: quote, userPublicKey: operator });
    const vtx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
    vtx.sign([signer]);
    const signature = bs58.encode(vtx.signatures[0]);

    const [row] = await conn
      .insert(schema.payoutSwaps)
      .values({ cycleId: cycle.id, ticker, cookRaw: portion, signature })
      .returning({ id: schema.payoutSwaps.id });
    await sol.sendRawTransaction(vtx.serialize(), { maxRetries: 3 });
    await sol.confirmTransaction(
      {
        signature,
        blockhash: vtx.message.recentBlockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
      },
      "confirmed",
    );
    const tx = await sol.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || tx.meta?.err) throw new Error(`the ${ticker} swap did not land`);
    await conn
      .update(schema.payoutSwaps)
      .set({ assetRaw: received(tx, operator, ticker) })
      .where(eq(schema.payoutSwaps.id, row.id));
  }

  await update(cycle.id, { status: "sending", note: null });
  return "swapped";
}

// --- sending: pay the wallets ---------------------------------------------------------------------------

/** A line as the batching rule sees it: which wallet, which asset, and how it has gone so far. */
export interface SendCandidate {
  id: number;
  wallet: string;
  ticker: string;
  attempts: number;
}

/**
 * The recipients one transaction pays: a wallet's lines in one asset go together, and a wallet whose
 * send has already failed goes on its own.
 *
 * Batching is what keeps a run affordable, but it also means one account that cannot receive takes
 * four innocent ones down with it, every call, for as long as it fails. Once a recipient has a
 * failure behind it, it is sent alone: either it lands, or it is plainly the one at fault and the
 * others are paid meanwhile.
 */
export function sendBatch<T extends SendCandidate>(pending: readonly T[], batchSize: number): T[][] {
  const groups = new Map<string, T[]>();
  for (const l of pending) {
    const key = `${l.wallet}|${l.ticker}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const all = [...groups.values()];
  const troubled = all.find((g) => g.some((l) => l.attempts > 0));
  return troubled ? [troubled] : all.slice(0, batchSize);
}

/**
 * Count a send that did not land against its lines, and give up on a wallet that has failed too often.
 *
 * A failed line keeps its share out of the token's pool rather than returning it: the wallet was
 * owed the money and only the send could not be made, so returning it would pay the amount twice.
 */
async function sendFailed(ids: number[]) {
  if (ids.length === 0) return;
  const conn = requireDb();
  const { payoutLines } = schema;
  await conn
    .update(payoutLines)
    .set({ signature: null, attempts: sql`${payoutLines.attempts} + 1` })
    .where(inArray(payoutLines.id, ids));
  await conn
    .update(payoutLines)
    .set({ status: "failed" })
    .where(and(inArray(payoutLines.id, ids), gte(payoutLines.attempts, MAX_LINE_ATTEMPTS)));
}

async function send(cycle: Cycle, signer: Keypair, now: Date): Promise<string> {
  const conn = requireDb();
  const sol = solanaConn();
  const { payoutLines } = schema;
  const operator = signer.publicKey;

  // Settle what an earlier call sent before sending anything new.
  const inFlight = await conn
    .selectDistinct({ signature: payoutLines.signature })
    .from(payoutLines)
    .where(
      and(
        eq(payoutLines.paidIn, cycle.id),
        eq(payoutLines.status, "queued"),
        isNotNull(payoutLines.signature),
      ),
    );
  for (const { signature } of inFlight) {
    const status = (await sol.getSignatureStatus(signature!, { searchTransactionHistory: true }))
      .value;
    const landed =
      status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "");
    const lost =
      status?.err ||
      (!status && cycle.stepAt && now.getTime() - cycle.stepAt.getTime() > DROPPED_AFTER_MS);
    if (landed) {
      await conn
        .update(payoutLines)
        .set({ status: "sent" })
        .where(eq(payoutLines.signature, signature!));
    } else if (lost) {
      const carried = await conn
        .select({ id: payoutLines.id })
        .from(payoutLines)
        .where(eq(payoutLines.signature, signature!));
      await sendFailed(carried.map((l) => l.id));
    } else {
      return "waiting for a send to confirm";
    }
  }

  const swaps = await conn
    .select()
    .from(schema.payoutSwaps)
    .where(eq(schema.payoutSwaps.cycleId, cycle.id));
  const bought = new Map(swaps.map((s) => [s.ticker, s.assetRaw ?? 0n]));
  const all = await queuedLines(cycle.id);
  const amounts = lineAmounts(all, bought);

  const started = Date.now();
  let sentWallets = 0;
  for (;;) {
    const pending = await conn
      .select()
      .from(payoutLines)
      .where(
        and(
          eq(payoutLines.paidIn, cycle.id),
          eq(payoutLines.status, "queued"),
          isNull(payoutLines.signature),
        ),
      );
    if (pending.length === 0) break;
    if (Date.now() - started > SEND_BUDGET_MS) return `sent to ${sentWallets} wallets, more next call`;

    // One recipient is one wallet in one asset, however many tokens its lines came from.
    const batch = sendBatch(pending, SEND_BATCH);

    const tx = new Transaction();
    const ids: number[] = [];
    for (const group of batch) {
      const asset = rwaByTicker(group[0].ticker);
      const raw = group.reduce((sum, l) => sum + (amounts.get(l.id) ?? 0n), 0n);
      for (const l of group) {
        await conn
          .update(payoutLines)
          .set({ assetRaw: amounts.get(l.id) ?? 0n })
          .where(eq(payoutLines.id, l.id));
      }
      if (!asset || raw <= 0n) {
        // Nothing to send: the asset is no longer supported or the share rounded to zero units.
        await conn
          .update(payoutLines)
          .set({ status: "sent" })
          .where(inArray(payoutLines.id, group.map((l) => l.id)));
        continue;
      }
      const owner = new PublicKey(group[0].wallet);
      const mint = new PublicKey(asset.mint);
      const destination = token22Ata(mint, owner);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          operator,
          destination,
          owner,
          mint,
          TOKEN_2022_PROGRAM_ID,
        ),
        createTransferCheckedInstruction(
          token22Ata(mint, operator),
          mint,
          destination,
          operator,
          raw,
          asset.decimals,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      );
      ids.push(...group.map((l) => l.id));
    }
    if (ids.length === 0) continue;

    const latest = await sol.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = operator;
    tx.sign(signer);
    const signature = bs58.encode(tx.signature!);

    await conn.update(payoutLines).set({ signature }).where(inArray(payoutLines.id, ids));
    await update(cycle.id, { stepAt: new Date() });
    await sol.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const confirmed = await sol.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmed.value.err) {
      await sendFailed(ids);
      throw new Error(`a payout send failed: ${JSON.stringify(confirmed.value.err)}`);
    }
    await conn.update(payoutLines).set({ status: "sent" }).where(inArray(payoutLines.id, ids));
    sentWallets += batch.length;
  }

  const solNow = BigInt(await sol.getBalance(operator, "confirmed"));
  const spent = (cycle.solBefore ?? solNow) + (bought.get("SOL") ?? 0n) - solNow;
  const solUsd = await fetchSolUsd();
  await update(cycle.id, {
    status: "done",
    costsUsd: solUsd && spent > 0n ? (Number(spent) / 1e9) * solUsd : 0,
    stepAt: null,
    note: null,
  });
  return `done, sent to ${sentWallets} wallets`;
}
