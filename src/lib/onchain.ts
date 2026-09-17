/**
 * Proving that something a client claims actually happened.
 *
 * Two things Coorwa writes down are reported by a browser after the fact: a fill, for cashback, and
 * a launch, for the token's benchmark. A client could claim either without doing it, so neither is
 * written until the transaction behind it has been read back from the chain: it must exist, it must
 * have succeeded, and it must have been signed by the wallet asking for the credit. What is left
 * after that is not a claim, it is a record of a public event anyone can check on the explorer.
 *
 * Server-side only. `tx.ts` is the browser half of this and does the opposite job.
 */
import { Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { COOKIE_RPC_URL, serverSolanaRpcUrl } from "./config";

export type Chain = "cookie" | "solana";

export interface ProvenTransaction {
  tx: VersionedTransactionResponse;
  /** Every address the transaction touched, in order, lookup tables included. */
  keys: string[];
  /** The same addresses, for asking whether one was named at all. */
  accounts: Set<string>;
}

export interface ProofFailure {
  error: string;
  status: number;
}

export function isProven(r: ProvenTransaction | ProofFailure): r is ProvenTransaction {
  return "tx" in r;
}

function keysOf(tx: VersionedTransactionResponse): string[] {
  try {
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses,
    });
    return Array.from({ length: keys.length }, (_, i) => keys.get(i)?.toBase58() ?? "");
  } catch {
    // A transaction whose lookup tables did not resolve has no readable account list. An empty list
    // reads as "this address was not named", which is the safe answer for every caller here.
    return [];
  }
}

/**
 * How much of one token moved into an account on this transaction, in raw units.
 *
 * Read from the balances the chain recorded either side of the transaction rather than by decoding
 * instruction data, so it is the amount that actually landed and not the amount that was asked for.
 */
export function tokenCredited(
  proof: ProvenTransaction,
  account: string,
  mint: string,
): bigint | null {
  const index = proof.keys.indexOf(account);
  if (index < 0) return null;

  const at = (
    list:
      | { accountIndex: number; mint: string; uiTokenAmount: { amount: string } }[]
      | null
      | undefined,
  ) => list?.find((b) => b.accountIndex === index && b.mint === mint)?.uiTokenAmount.amount;

  const before = at(proof.tx.meta?.preTokenBalances);
  const after = at(proof.tx.meta?.postTokenBalances);
  if (after == null) return null;

  return BigInt(after) - BigInt(before ?? "0");
}

/**
 * How much native COOK an address gained on this transaction, in raw units. The swap fee and the pair
 * payment are plain transfers to the operator, so this is what proves either was paid.
 */
export function lamportsCredited(proof: ProvenTransaction, account: string): bigint | null {
  const index = proof.keys.indexOf(account);
  if (index < 0) return null;
  const before = proof.tx.meta?.preBalances?.[index];
  const after = proof.tx.meta?.postBalances?.[index];
  if (typeof before !== "number" || typeof after !== "number") return null;
  return BigInt(after) - BigInt(before);
}

export async function proveTransaction(args: {
  signature: string;
  /** The wallet asking for the credit. It has to be the fee payer. */
  wallet: string;
  chain?: Chain;
}): Promise<ProvenTransaction | ProofFailure> {
  const conn = new Connection(
    args.chain === "solana" ? serverSolanaRpcUrl() : COOKIE_RPC_URL,
    "confirmed",
  );
  const tx = await conn.getTransaction(args.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!tx) return { error: "that transaction was not found on chain", status: 404 };
  if (tx.meta?.err) return { error: "that transaction failed on chain", status: 409 };

  // The fee payer is the first signer. Crediting anyone else would let a caller credit a stranger,
  // or claim a launch somebody else paid for.
  const signer = tx.transaction.message.getAccountKeys().get(0)?.toBase58();
  if (signer !== args.wallet) {
    return { error: "that transaction was not signed by this wallet", status: 403 };
  }

  const keys = keysOf(tx);
  return { tx, keys, accounts: new Set(keys) };
}
