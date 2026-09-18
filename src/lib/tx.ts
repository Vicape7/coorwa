"use client";

/**
 * Client-side transaction execution.
 *
 * Coorwa is non-custodial by construction: aggregators build an unsigned transaction server-side,
 * the user's wallet signs it in their own browser, and it is sent from there. No key, and no
 * co-signature, ever reaches Coorwa. Every send is simulated first so a doomed transaction fails
 * for free instead of on-chain.
 */
import {
  Connection,
  VersionedTransaction,
  Transaction,
  type SendOptions,
} from "@solana/web3.js";
import { BuildMismatchError } from "./expectation";
import { refuseBadSwap, type SwapWatch } from "./swap-check";

export type SignerFn = <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;

export function decodeTx(base64: string): VersionedTransaction | Transaction {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    // Some builders still return a legacy message.
    return Transaction.from(bytes);
  }
}

export function encodeTx(tx: VersionedTransaction | Transaction): string {
  const bytes =
    tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false });
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export class SimulationError extends Error {
  constructor(
    message: string,
    readonly logs: string[] | null,
  ) {
    super(message);
    this.name = "SimulationError";
  }
}

/** Simulate before sending. A failing simulation is a real failure, not a warning. */
export async function simulate(
  connection: Connection,
  tx: VersionedTransaction | Transaction,
): Promise<void> {
  if (!(tx instanceof VersionedTransaction)) return;

  const res = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
  });

  if (res.value.err) {
    const logs = res.value.logs ?? null;
    const custom = logs?.find((l) => /Error|failed|insufficient/i.test(l));
    throw new SimulationError(
      custom?.trim() ?? `simulation failed: ${JSON.stringify(res.value.err)}`,
      logs,
    );
  }
}

/**
 * Refuse a swap build that is not the trade it was asked for, before the wallet is asked to sign.
 *
 * Aggregator routes cannot be read instruction by instruction the way a launchpad build can, so
 * `swap-check.ts` judges them by what simulating them does to the wallet's balances. A legacy build
 * is compiled into the same shape rather than skipped, so answering in the older format is not a way
 * around the check.
 */
export async function checkSwapBuild(
  connection: Connection,
  tx: VersionedTransaction | Transaction,
  watch: SwapWatch,
): Promise<void> {
  const versioned =
    tx instanceof VersionedTransaction ? tx : new VersionedTransaction(tx.compileMessage());
  const refusal = await refuseBadSwap(connection, versioned, watch);
  if (refusal) throw new BuildMismatchError(`this is not the trade you asked for, ${refusal}`);
}

export interface SendResult {
  signature: string;
  confirmed: boolean;
}

/** Sign, send and confirm on the given connection. */
export async function signSendConfirm(
  connection: Connection,
  tx: VersionedTransaction | Transaction,
  signTransaction: SignerFn,
  opts: SendOptions = {},
): Promise<SendResult> {
  await simulate(connection, tx);

  const signed = await signTransaction(tx);
  const raw =
    signed instanceof VersionedTransaction
      ? signed.serialize()
      : signed.serialize({ requireAllSignatures: false });

  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
    ...opts,
  });

  // Confirmed against the blockhash the transaction was actually signed with: a wallet may replace
  // the one it was built with. How long that blockhash stays valid is not known for a build that
  // came from elsewhere, so the wait ends at the newest blockhash's last valid height. That is never
  // earlier than the transaction's own, so a transaction still able to land is never given up on;
  // one that has expired is reported a little later than it could be.
  const blockhash =
    signed instanceof VersionedTransaction
      ? signed.message.recentBlockhash
      : (signed.recentBlockhash ?? "");
  const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const res = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return { signature, confirmed: !res.value.err };
}

export function explainError(e: unknown): string {
  if (e instanceof SimulationError) return e.message;
  // Already written for the user, and it must not be mistaken for anything below.
  if (e instanceof BuildMismatchError) return e.message;
  if (e instanceof Error) {
    const m = e.message;
    if (/User rejected|rejected the request/i.test(m)) return "You rejected the transaction.";
    if (/insufficient|0x1\b/i.test(m)) return "Not enough balance for this trade plus fees.";
    if (/blockhash not found|block height exceeded/i.test(m)) {
      return "The quote went stale before it landed. Try again.";
    }
    if (/slippage|6001|0x1771/i.test(m)) {
      return "Price moved past your slippage limit. Raise slippage or trade smaller.";
    }
    return m;
  }
  return "Something went wrong.";
}
