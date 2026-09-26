/**
 * The tax sweep: from the transfer tax a Coorwa token withheld to COOK its holders are owed.
 *
 * A token launched on Coorwa's curve is a Token-2022 mint with a transfer fee, and the fee is not
 * paid to anyone when it is charged: it is withheld inside the account the transfer landed in. Only
 * the mint's withdraw authority, which the launch config makes the operator wallet, can take it out.
 * So once an hour, for every token still trading on its curve, this:
 *
 *   1. harvests the withheld tax out of every holder's account into the mint, which anyone may do;
 *   2. withdraws it from the mint into the operator's own account for that token;
 *   3. sells all of it back to the curve for COOK, in the same transaction as the withdrawal;
 *   4. writes the COOK the sale paid, valued in dollars, as owed to that token's holders.
 *
 * From there the daily run (`payout-cycle.ts`) treats it like any other fee: shared over the holders
 * by what they held across the day, bridged, bought as the pair's stock and sent.
 *
 * The sale is written down before it is sent and settled from the chain afterwards, so a call that
 * dies halfway leaves a row the next call checks rather than a sale nobody accounted for. A second
 * caller cannot sell the same token at the same time: only one unsettled sale per token fits in the
 * table. The sale pays the curve's fee and, because it is a transfer too, the token's own tax, which
 * stays withheld in the curve's vault and is swept on the next pass.
 *
 * A token whose curve has filled is left alone until its pool is open, since there is nothing to
 * sell into in between; selling into the pool comes with the graduation crank. Server only.
 */
import bs58 from "bs58";
import { Connection, PublicKey, Transaction, type Keypair } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync,
  getTransferFeeAmount,
  getTransferFeeConfig,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { db, schema } from "./db";
import { fetchCookPriceUsd } from "./cookiescan";
import { operatorKeypair } from "./operator";
import {
  fetchCurve,
  fetchCurves,
  fetchLaunchConfig,
  quoteSell,
  tradedEvents,
  type CurveState,
} from "./launch-program";
import { tradeInstructions } from "./launch-flow";
import { COOKIE_RPC_URL, COOK_DECIMALS } from "./config";

type Sweep = typeof schema.taxSweeps.$inferSelect;

/** How often every curve is looked at. The daily run pays out whatever the passes before it sold. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000;
/**
 * Below this much COOK a token's tax waits for the next pass. A pass costs a few thousandths of a
 * COOK in fees, so this is not about cost: it keeps a quiet token from writing a row an hour.
 */
export const SWEEP_MIN_COOK = 10n * 10n ** BigInt(COOK_DECIMALS);
/** How far the curve may move against the sale between the quote and the transaction landing. */
export const SWEEP_SLIPPAGE_BPS = 200;
/** Accounts harvested per transaction, well inside the size limit at 32 bytes each. */
export const HARVEST_BATCH = 24;
/** A sale that has not shown up by now never will: its blockhash has long expired. */
const DROPPED_AFTER_MS = 3 * 60 * 1000;
/** How long one call keeps sweeping before it leaves the rest of the pass to the next call. */
const SWEEP_BUDGET_MS = 20 * 1000;

export interface TaxSweepResult {
  action: string;
  detail?: string;
}

function requireDb() {
  if (!db) throw new Error("the tax sweep needs DATABASE_URL");
  return db;
}

// --- pure parts ---------------------------------------------------------------------------------------

/** Accounts that hold withheld tax, and how much of it in total. */
export function withheldIn(accounts: readonly { address: PublicKey; withheld: bigint }[]) {
  const holding = accounts.filter((a) => a.withheld > 0n);
  return {
    sources: holding.map((a) => a.address),
    total: holding.reduce((sum, a) => sum + a.withheld, 0n),
  };
}

/** Split the accounts to harvest into transactions of at most `size` each. */
export function harvestBatches<T>(sources: readonly T[], size = HARVEST_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < sources.length; i += size) out.push(sources.slice(i, i + size));
  return out;
}

/**
 * What selling `amount` tokens to this curve should pay, and the least the sale will accept. Null
 * when the curve is not trading or the sale would pay less than `minCook`.
 */
export function salePlan(
  curve: CurveState,
  amount: bigint,
  minCook = SWEEP_MIN_COOK,
  slippageBps = SWEEP_SLIPPAGE_BPS,
): { amount: bigint; expected: bigint; minOut: bigint } | null {
  if (curve.state !== "live" || amount <= 0n) return null;
  const expected = quoteSell(curve, amount).quoteOut;
  if (expected < minCook) return null;
  return { amount, expected, minOut: (expected * BigInt(10_000 - slippageBps)) / 10_000n };
}

/** The COOK a confirmed transaction paid the operator for this token, from the program's own event. */
export function saleProceeds(
  logs: string[] | null | undefined,
  mint: string,
  operator: string,
): bigint {
  return tradedEvents(logs)
    .filter((e) => !e.isBuy && e.mint.toBase58() === mint && e.trader.toBase58() === operator)
    .reduce((sum, e) => sum + e.quoteAmount, 0n);
}

// --- settling a sale ------------------------------------------------------------------------------------

/**
 * Settle a sale that was sent: sold with what it paid, failed if it never landed, or left as it is
 * while the chain has not decided yet.
 */
async function settle(
  cookie: Connection,
  row: Sweep,
  operator: string,
  now: Date,
): Promise<"sold" | "failed" | "waiting"> {
  const conn = requireDb();
  const { taxSweeps } = schema;
  const fail = async (note: string) => {
    await conn
      .update(taxSweeps)
      .set({ status: "failed", note: note.slice(0, 500), settledAt: now })
      .where(eq(taxSweeps.id, row.id));
    return "failed" as const;
  };

  const status = (
    await cookie.getSignatureStatus(row.signature!, { searchTransactionHistory: true })
  ).value;
  if (status?.err) return fail(`the sale failed: ${JSON.stringify(status.err)}`);
  if (!status) {
    return now.getTime() - row.createdAt.getTime() > DROPPED_AFTER_MS
      ? fail("the sale never landed")
      : "waiting";
  }
  if (!["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) return "waiting";

  const tx = await cookie.getTransaction(row.signature!, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) return "waiting";
  // Priced when it is settled, which is when it starts counting towards the holders' pool.
  const cookPriceUsd = await fetchCookPriceUsd();
  if (!cookPriceUsd) {
    await conn
      .update(taxSweeps)
      .set({ note: "sold, waiting for a COOK price to value it" })
      .where(eq(taxSweeps.id, row.id));
    return "waiting";
  }
  const cookRaw = saleProceeds(tx.meta?.logMessages, row.mint, operator);
  await conn
    .update(taxSweeps)
    .set({
      status: "sold",
      cookRaw,
      cookPriceUsd,
      valueUsd: (Number(cookRaw) / 10 ** COOK_DECIMALS) * cookPriceUsd,
      note: null,
      settledAt: now,
    })
    .where(eq(taxSweeps.id, row.id));
  return "sold";
}

// --- one token ------------------------------------------------------------------------------------------

async function send(cookie: Connection, tx: Transaction, signer: Keypair): Promise<string> {
  const latest = await cookie.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const signature = bs58.encode(tx.signature!);
  await cookie.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const confirmed = await cookie.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) throw new Error(`transaction failed: ${JSON.stringify(confirmed.value.err)}`);
  return signature;
}

/** The withheld tax of one mint, account by account, and what the operator already holds of it. */
async function readTax(cookie: Connection, mint: PublicKey, operatorAccount: PublicKey) {
  const [mintInfo, accounts] = await Promise.all([
    cookie.getAccountInfo(mint, "confirmed"),
    cookie.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    }),
  ]);
  const feeConfig = getTransferFeeConfig(unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID));

  let own = 0n;
  const withheld: { address: PublicKey; withheld: bigint }[] = [];
  for (const a of accounts) {
    let account;
    try {
      account = unpackAccount(a.pubkey, a.account, TOKEN_2022_PROGRAM_ID);
    } catch {
      continue; // the mint itself can match the filter
    }
    if (!account.mint.equals(mint)) continue;
    if (a.pubkey.equals(operatorAccount)) own = account.amount;
    withheld.push({ address: a.pubkey, withheld: getTransferFeeAmount(account)?.withheldAmount ?? 0n });
  }
  return { feeConfig, own, accounts: withheldIn(withheld) };
}

/** Sweep one token, returning a line for the pass's report. */
async function sweepCurve(cookie: Connection, signer: Keypair, curve: CurveState): Promise<string> {
  const conn = requireDb();
  const mint = curve.mint;
  const label = mint.toBase58().slice(0, 4);
  if (curve.state !== "live") return `${label} waits for its pool`;

  const operator = signer.publicKey;
  const operatorAccount = getAssociatedTokenAddressSync(mint, operator, false, TOKEN_2022_PROGRAM_ID);
  const tax = await readTax(cookie, mint, operatorAccount);
  if (!tax.feeConfig?.withdrawWithheldAuthority.equals(operator)) {
    return `${label} is not withheld for the operator`;
  }

  // Worth it at all? Counted before harvesting, so a quiet token costs one read and nothing else.
  const total = tax.own + tax.feeConfig.withheldAmount + tax.accounts.total;
  if (!salePlan(curve, total)) return `${label} has too little tax yet`;

  for (const batch of harvestBatches(tax.accounts.sources)) {
    await send(
      cookie,
      new Transaction().add(
        createHarvestWithheldTokensToMintInstruction(mint, batch, TOKEN_2022_PROGRAM_ID),
      ),
      signer,
    );
  }

  // Read again after the harvest: the mint's figure is now exact, and the curve may have moved.
  const [after, fresh] = await Promise.all([readTax(cookie, mint, operatorAccount), fetchCurve(cookie, mint)]);
  const inMint = after.feeConfig?.withheldAmount ?? 0n;
  const plan = fresh ? salePlan(fresh, after.own + inMint) : null;
  if (!plan) return `${label} could not be sold after the harvest`;

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      operator,
      operatorAccount,
      operator,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  if (inMint > 0n) {
    tx.add(
      createWithdrawWithheldTokensFromMintInstruction(
        mint,
        operatorAccount,
        operator,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  // The COOK stays wrapped: the payout run's bridge step unwraps the operator's account itself.
  tx.add(
    ...tradeInstructions({
      trader: operator,
      mint,
      side: "sell",
      amount: plan.amount,
      minOut: plan.minOut,
      closeWrapped: false,
    }),
  );
  const latest = await cookie.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = operator;
  tx.sign(signer);
  const signature = bs58.encode(tx.signature!);

  const inserted = await conn
    .insert(schema.taxSweeps)
    .values({ mint: mint.toBase58(), status: "pending", signature, tokenRaw: plan.amount })
    .onConflictDoNothing()
    .returning({ id: schema.taxSweeps.id });
  if (inserted.length === 0) return `${label} is being sold by another call`;

  await cookie.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  // A confirmation that times out is not a failure: the row is settled from the chain either way.
  await cookie.confirmTransaction({ signature, ...latest }, "confirmed").catch(() => null);
  const [row] = await conn
    .select()
    .from(schema.taxSweeps)
    .where(eq(schema.taxSweeps.id, inserted[0].id));
  const outcome = await settle(cookie, row, operator.toBase58(), new Date());
  return `${label} ${outcome}, ${Number(plan.expected) / 10 ** COOK_DECIMALS} COOK expected`;
}

// --- the pass -------------------------------------------------------------------------------------------

/** Settle what earlier calls sent, then sweep every curve if a pass is due. */
export async function runTaxSweep(now = new Date()): Promise<TaxSweepResult> {
  const signer = operatorKeypair();
  if (!signer) return { action: "off", detail: "no operator key" };
  const conn = requireDb();
  const { taxSweeps } = schema;
  const cookie = new Connection(COOKIE_RPC_URL, "confirmed");
  const operator = signer.publicKey.toBase58();

  const pending = await conn.select().from(taxSweeps).where(eq(taxSweeps.status, "pending"));
  for (const row of pending) await settle(cookie, row, operator, now);

  const [last] = await conn
    .select({ at: taxSweeps.createdAt })
    .from(taxSweeps)
    .where(eq(taxSweeps.status, "pass"))
    .orderBy(desc(taxSweeps.id))
    .limit(1);
  const since = last?.at ?? new Date(0);
  const due = new Date(since.getTime() + SWEEP_EVERY_MS);
  if (due > now) return { action: "idle", detail: `next pass due ${due.toISOString()}` };

  const config = await fetchLaunchConfig(cookie);
  if (!config) return { action: "off", detail: "no launch config on chain" };
  if (!config.withholdAuthority.equals(signer.publicKey)) {
    return { action: "off", detail: `the tax is withheld for ${config.withholdAuthority.toBase58()}` };
  }

  // Tokens an earlier call of this pass already sold are not sold twice.
  const touched = new Set(
    (
      await conn
        .selectDistinct({ mint: taxSweeps.mint })
        .from(taxSweeps)
        .where(and(gt(taxSweeps.createdAt, since), ne(taxSweeps.mint, "")))
    ).map((r) => r.mint),
  );
  const curves = (await fetchCurves(cookie)).filter((c) => !touched.has(c.mint.toBase58()));

  const started = Date.now();
  const report: string[] = [];
  for (const curve of curves) {
    if (Date.now() - started > SWEEP_BUDGET_MS) {
      return { action: "sweeping", detail: `${report.join("; ")}; the rest next call` };
    }
    try {
      report.push(await sweepCurve(cookie, signer, curve));
    } catch (e) {
      report.push(`${curve.mint.toBase58().slice(0, 4)} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await conn.insert(taxSweeps).values({ mint: "", status: "pass", note: report.join("; ").slice(0, 500) });
  return { action: "swept", detail: report.join("; ") || "no curves" };
}
