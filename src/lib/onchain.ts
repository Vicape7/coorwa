/**
 * Proving that something a client claims actually happened.
 *
 * Two things Corwa writes down are reported by a browser after the fact: a fill, for cashback, and
 * a launch, for the token's benchmark. A client could claim either without doing it, so neither is
 * written until the transaction behind it has been read back from the chain: it must exist, it must
 * have succeeded, and it must have been signed by the wallet asking for the credit. What is left
 * after that is not a claim, it is a record of a public event anyone can check on the explorer.
 *
 * Server-side only. `tx.ts` is the browser half of this and does the opposite job.
 */
import { Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { COOKIE_RPC_URL, SOLANA_RPC_URL } from "./config";

export type Chain = "cookie" | "solana";

export interface ProvenTransaction {
  tx: VersionedTransactionResponse;
  /** Every address the transaction touched, lookup tables included. */
  accounts: Set<string>;
}

export interface ProofFailure {
  error: string;
  status: number;
}

export function isProven(r: ProvenTransaction | ProofFailure): r is ProvenTransaction {
  return "tx" in r;
}

function accountsOf(tx: VersionedTransactionResponse): Set<string> {
  const out = new Set<string>();
  try {
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses,
    });
    for (let i = 0; i < keys.length; i++) {
      const k = keys.get(i);
      if (k) out.add(k.toBase58());
    }
  } catch {
    // A transaction whose lookup tables did not resolve has no readable account list. An empty set
    // reads as "this address was not named", which is the safe answer for every caller here.
  }
  return out;
}

export async function proveTransaction(args: {
  signature: string;
  /** The wallet asking for the credit. It has to be the fee payer. */
  wallet: string;
  chain?: Chain;
}): Promise<ProvenTransaction | ProofFailure> {
  const conn = new Connection(
    args.chain === "solana" ? SOLANA_RPC_URL : COOKIE_RPC_URL,
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

  return { tx, accounts: accountsOf(tx) };
}
