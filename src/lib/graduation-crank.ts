/**
 * The graduation crank: the moment a curve fills, open its pool and lock the liquidity.
 *
 * The program does the work in one instruction and anyone may send it, but somebody has to, and
 * until they do the token cannot trade at all: its curve is closed and its pool does not exist. So
 * on every scheduler call this looks for curves that have filled and graduates each one, paid for by
 * the operator. Two ways through, both in `launch-program.ts`:
 *
 *   - `graduate` when the pool's address is free, which is the normal case;
 *   - `graduate_into_pool` when somebody opened that pool first, trading it back to the curve's
 *     price before depositing. If they also put its first trade in the future, the pool program
 *     will not trade it until then, and the crank waits.
 *
 * Whoever graduates pays the rent for the accounts the pool program creates, handed to the curve's
 * vault authority in the same transaction. The exact amount is measured by simulating the whole
 * transaction first, so nothing is left behind in an address nobody can spend from.
 *
 * `planGraduation` is shared with `scripts/graduate.mjs`, which runs the same plan by hand. The
 * scheduled crank stays off until `GRADUATION_CRANK=on`, so the first graduation on the real chain
 * is one somebody watched. Nothing here is stored: the curve account says whether a graduation
 * happened, and sending it twice fails harmlessly on the program's own state check.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount } from "@solana/spl-token";
import {
  baseVault,
  dammPoolPda,
  decodeDammPool,
  existingPoolGraduation,
  fetchCurves,
  graduateIntoPoolIx,
  graduateIx,
  graduationParams,
  quoteVault,
  vaultAuthorityPda,
  type CurveState,
} from "./launch-program";
import { operatorKeypair } from "./operator";
import { COOKIE_RPC_URL, COOK_MINT } from "./config";

/** Handed to the vault authority for the simulation only; the real transaction sends what it used. */
const PROBE_RENT = 200_000_000;
/** The most a transaction may ask for, used while measuring. */
const MAX_UNITS = 1_400_000;

export type GraduationPlan =
  | { kind: "not-ready"; reason: string }
  | { kind: "wait"; reason: string; until?: Date }
  | { kind: "failed"; reason: string; logs: string[] }
  | {
      kind: "fresh" | "into";
      instructions: TransactionInstruction[];
      /** The position NFT's mint, a fresh key that signs alongside the payer. */
      positionNft: Keypair;
      rent: number;
      units: number;
      liquidity: bigint;
      swapIn: bigint;
    };

/**
 * What to send so that the vault authority ends with nothing, or with at least the rent-exempt
 * minimum: a system account holding less than that, but more than nothing, is refused by the chain.
 */
export function rentToSend(args: { before: number; used: number; rentMin: number }): number {
  const short = Math.max(0, args.used - args.before);
  const after = args.before + short - args.used;
  return after > 0 && after < args.rentMin ? short + args.rentMin - after : short;
}

/**
 * Work out and measure one curve's graduation, for `payer` to send. Nothing is sent here.
 *
 * The instruction is built from what is on chain right now, then the whole transaction is simulated
 * with a generous rent to learn what the pool program actually takes and how much compute the
 * graduation uses. The plan it returns carries those exact figures.
 */
export async function planGraduation(
  connection: Connection,
  curve: CurveState,
  payer: PublicKey,
  now = new Date(),
): Promise<GraduationPlan> {
  if (curve.state !== "graduated") {
    return { kind: "not-ready", reason: `the curve is ${curve.state}` };
  }
  const mint = curve.mint;
  const quoteMint = new PublicKey(COOK_MINT);
  const authority = vaultAuthorityPda(mint);
  const positionNft = Keypair.generate();

  const [baseHeld, quoteHeld, poolInfo, before, rentMin] = await Promise.all([
    getAccount(connection, baseVault(mint), "confirmed", TOKEN_2022_PROGRAM_ID),
    getAccount(connection, quoteVault(mint, quoteMint), "confirmed"),
    connection.getAccountInfo(dammPoolPda(mint, quoteMint), "confirmed"),
    connection.getBalance(authority, "confirmed"),
    connection.getMinimumBalanceForRentExemption(0),
  ]);

  let kind: "fresh" | "into";
  let ix: TransactionInstruction;
  let liquidity: bigint;
  let swapIn = 0n;
  if (!poolInfo) {
    kind = "fresh";
    const params = graduationParams(curve, baseHeld.amount);
    liquidity = params.liquidity;
    ix = graduateIx({
      mint,
      quoteMint,
      positionNftMint: positionNft.publicKey,
      liquidity,
      sqrtPrice: params.sqrtPrice,
    });
  } else {
    kind = "into";
    const pool = decodeDammPool(poolInfo.data);
    // This config counts a pool's first trade in unix seconds.
    const opens = new Date(Number(pool.activationPoint) * 1000);
    if (opens > now) {
      return { kind: "wait", reason: "somebody opened the pool first and its first trade is not due yet", until: opens };
    }
    if (pool.status !== 0) return { kind: "wait", reason: "the pool is disabled by its operator" };
    const plan = existingPoolGraduation(curve, pool, {
      base: baseHeld.amount,
      quote: quoteHeld.amount - curve.feesQuote,
    });
    liquidity = plan.liquidity;
    swapIn = plan.swapIn;
    ix = graduateIntoPoolIx({
      mint,
      quoteMint,
      positionNftMint: positionNft.publicKey,
      liquidity,
      swapIn,
    });
  }

  const probe = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_UNITS }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: authority, lamports: PROBE_RENT }),
    ix,
  );
  probe.feePayer = payer;
  probe.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = await connection.simulateTransaction(probe.compileMessage(), undefined, [authority]);
  if (sim.value.err) {
    return {
      kind: "failed",
      reason: `the graduation would fail: ${JSON.stringify(sim.value.err)}`,
      logs: sim.value.logs ?? [],
    };
  }
  const after = sim.value.accounts?.[0]?.lamports ?? before + PROBE_RENT;
  const used = before + PROBE_RENT - after;
  const rent = rentToSend({ before, used, rentMin });
  // A fifth over what was measured, which is still far under the ceiling.
  const units = Math.min(MAX_UNITS, Math.ceil((sim.value.unitsConsumed ?? MAX_UNITS) * 1.2));

  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (rent > 0) {
    instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: authority, lamports: rent }));
  }
  instructions.push(ix);
  return { kind, instructions, positionNft, rent, units, liquidity, swapIn };
}

/** Sign and send a plan, returning the signature once it has confirmed. */
export async function sendGraduation(
  connection: Connection,
  plan: Extract<GraduationPlan, { instructions: TransactionInstruction[] }>,
  payer: Keypair,
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...plan.instructions);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(payer, plan.positionNft);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) {
    throw new Error(`the graduation failed: ${JSON.stringify(confirmed.value.err)} (${signature})`);
  }
  return signature;
}

export interface CrankResult {
  action: string;
  detail?: string;
}

/** Graduate every curve that has filled. Called by the scheduler; off until GRADUATION_CRANK=on. */
export async function runGraduationCrank(now = new Date()): Promise<CrankResult> {
  if (process.env.GRADUATION_CRANK?.trim() !== "on") return { action: "off", detail: "GRADUATION_CRANK is not on" };
  const signer = operatorKeypair();
  if (!signer) return { action: "off", detail: "no operator key" };

  const connection = new Connection(COOKIE_RPC_URL, "confirmed");
  const filled = (await fetchCurves(connection)).filter((c) => c.state === "graduated");
  if (filled.length === 0) return { action: "idle", detail: "no curve is waiting for its pool" };

  const report: string[] = [];
  for (const curve of filled) {
    const label = curve.mint.toBase58().slice(0, 4);
    try {
      const plan = await planGraduation(connection, curve, signer.publicKey, now);
      if (!("instructions" in plan)) {
        report.push(`${label} ${plan.kind}: ${plan.reason}${plan.kind === "wait" && plan.until ? ` until ${plan.until.toISOString()}` : ""}`);
        continue;
      }
      const signature = await sendGraduation(connection, plan, signer);
      report.push(`${label} graduated (${plan.kind}) ${signature}`);
    } catch (e) {
      report.push(`${label} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { action: "graduating", detail: report.join("; ") };
}
