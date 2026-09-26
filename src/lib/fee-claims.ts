/**
 * Collecting what Coorwa's launch program owes: the curve fee, and the locked pool's fees.
 *
 * Both instructions are permissionless and both destinations are fixed on chain, so sending them is
 * housekeeping rather than a decision. The curve fee (1% of every curve trade) waits on the curve
 * account until claimed and goes whole to the config's fee recipient. The pool's fees are collected
 * from the locked position and split in the same instruction, 40% to the creator and 60% to the fee
 * recipient, so nobody is paid without the other.
 *
 * The curve says exactly how much fee it holds. The pool does not, so its claim is simulated first
 * and the amounts read off the token accounts it would credit; a claim worth less than
 * `FEE_CLAIM_MIN_COOK` waits for the next pass. Run from the tax sweep's hourly pass, right after a
 * token's tax is sold, because that sale pays a fee of its own. `scripts/claim-fees.mjs` runs the same
 * plan by hand.
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { claimCurveFeesIx, claimPoolFeesIx, type CurveState } from "./launch-program";
import { COOK_DECIMALS, COOK_MINT } from "./config";

/** Below this much COOK a claim waits: sending it costs a few thousandths, but there is no hurry. */
export const FEE_CLAIM_MIN_COOK = 10n * 10n ** BigInt(COOK_DECIMALS);

/** The most a transaction may ask for, used while measuring. */
const MAX_UNITS = 1_400_000;

export type FeeClaimPlan =
  | { kind: "none"; reason: string }
  | { kind: "failed"; reason: string; logs: string[] }
  | {
      kind: "curve" | "pool";
      instructions: TransactionInstruction[];
      /** COOK to the fee recipient, raw. */
      toPlatform: bigint;
      /** COOK to the creator, raw; always zero for the curve fee. */
      toCreator: bigint;
      /** Token fees, which a pool that lists the token second keeps in the token instead. */
      baseToPlatform: bigint;
      baseToCreator: bigint;
    };

/** The curve fee, when enough has built up. Nothing is sent here. */
export function planCurveFeeClaim(
  curve: CurveState,
  payer: PublicKey,
  feeRecipient: PublicKey,
  min = FEE_CLAIM_MIN_COOK,
): FeeClaimPlan {
  if (curve.feesQuote < min) return { kind: "none", reason: "too little curve fee yet" };
  const quoteMint = new PublicKey(COOK_MINT);
  const recipient = getAssociatedTokenAddressSync(quoteMint, feeRecipient, true);
  return {
    kind: "curve",
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(payer, recipient, feeRecipient, quoteMint),
      claimCurveFeesIx(curve.mint, quoteMint, recipient),
    ],
    toPlatform: curve.feesQuote,
    toCreator: 0n,
    baseToPlatform: 0n,
    baseToCreator: 0n,
  };
}

/** A token account's amount, which sits at the same offset for both token programs. */
function amountOf(data: Buffer | null | undefined): bigint {
  return data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
}

/**
 * The pool's fees, measured by simulating the claim. Nothing is sent here.
 *
 * The four token accounts the program pays into are opened in the same transaction when they do
 * not exist yet, at the payer's expense: a creator who has sold out and closed their account still
 * has to be able to receive their share.
 */
export async function planPoolFeeClaim(
  connection: Connection,
  curve: CurveState,
  payer: PublicKey,
  feeRecipient: PublicKey,
  min = FEE_CLAIM_MIN_COOK,
): Promise<FeeClaimPlan> {
  if (curve.state !== "pooled") return { kind: "none", reason: `the curve is ${curve.state}` };
  const mint = curve.mint;
  const quoteMint = new PublicKey(COOK_MINT);
  const creator = curve.creator;
  const accounts = {
    creatorQuote: getAssociatedTokenAddressSync(quoteMint, creator, true),
    platformQuote: getAssociatedTokenAddressSync(quoteMint, feeRecipient, true),
    creatorBase: getAssociatedTokenAddressSync(mint, creator, true, TOKEN_2022_PROGRAM_ID),
    platformBase: getAssociatedTokenAddressSync(mint, feeRecipient, true, TOKEN_2022_PROGRAM_ID),
  };
  const watched = [
    accounts.creatorQuote,
    accounts.platformQuote,
    accounts.creatorBase,
    accounts.platformBase,
  ];

  const claim = [
    createAssociatedTokenAccountIdempotentInstruction(payer, accounts.creatorQuote, creator, quoteMint),
    createAssociatedTokenAccountIdempotentInstruction(payer, accounts.platformQuote, feeRecipient, quoteMint),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      accounts.creatorBase,
      creator,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      accounts.platformBase,
      feeRecipient,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    claimPoolFeesIx({
      mint,
      quoteMint,
      creator,
      positionNftMint: curve.positionNftMint,
      ...accounts,
    }),
  ];

  const before = await connection.getMultipleAccountsInfo(watched, "confirmed");
  const probe = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_UNITS }), ...claim);
  probe.feePayer = payer;
  probe.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = await connection.simulateTransaction(probe.compileMessage(), undefined, watched);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    if (logs.some((l) => l.includes("NothingToClaim"))) return { kind: "none", reason: "no pool fees yet" };
    return { kind: "failed", reason: `the claim would fail: ${JSON.stringify(sim.value.err)}`, logs };
  }

  const delta = (i: number) => {
    const after = sim.value.accounts?.[i];
    const data = after ? Buffer.from(after.data[0], "base64") : null;
    return amountOf(data) - amountOf(before[i]?.data);
  };
  const plan = {
    toCreator: delta(0),
    toPlatform: delta(1),
    baseToCreator: delta(2),
    baseToPlatform: delta(3),
  };
  // Token fees count too: a pool that lists the token first keeps its fee in COOK, but one opened
  // the other way round keeps it in the token, and that is still worth collecting.
  if (plan.toCreator + plan.toPlatform < min && plan.baseToCreator + plan.baseToPlatform === 0n) {
    return { kind: "none", reason: "too little pool fee yet" };
  }

  // A fifth over what was measured, which is still far under the ceiling.
  const units = Math.min(MAX_UNITS, Math.ceil((sim.value.unitsConsumed ?? MAX_UNITS) * 1.2));
  return {
    kind: "pool",
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...claim],
    ...plan,
  };
}

/** Sign and send a plan, returning the signature once it has confirmed. */
export async function sendFeeClaim(
  connection: Connection,
  plan: Extract<FeeClaimPlan, { instructions: TransactionInstruction[] }>,
  payer: Keypair,
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...plan.instructions);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) {
    throw new Error(`the claim failed: ${JSON.stringify(confirmed.value.err)} (${signature})`);
  }
  return signature;
}

const cook = (raw: bigint) => Number(raw) / 10 ** COOK_DECIMALS;

/** Claim whatever one token owes, returning a line for the pass's report. */
export async function claimFees(
  connection: Connection,
  signer: Keypair,
  curve: CurveState,
  feeRecipient: PublicKey,
): Promise<string> {
  const label = `${curve.mint.toBase58().slice(0, 4)} fees`;
  const lines: string[] = [];
  const plans = [
    planCurveFeeClaim(curve, signer.publicKey, feeRecipient),
    await planPoolFeeClaim(connection, curve, signer.publicKey, feeRecipient),
  ];
  for (const plan of plans) {
    if (plan.kind === "none") continue;
    if (plan.kind === "failed") {
      lines.push(plan.reason);
      continue;
    }
    const signature = await sendFeeClaim(connection, plan, signer);
    lines.push(
      plan.kind === "curve"
        ? `curve ${cook(plan.toPlatform)} COOK ${signature}`
        : `pool ${cook(plan.toPlatform)} + ${cook(plan.toCreator)} COOK to the creator ${signature}`,
    );
  }
  return lines.length > 0 ? `${label}: ${lines.join(", ")}` : `${label}: nothing to claim`;
}
