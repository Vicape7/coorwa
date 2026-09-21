/**
 * Proving that something a client claims actually happened.
 *
 * Two things Coorwa writes down are reported by a browser after the fact: a fill, for holder rewards,
 * and a launch, for the token's pair. A client could claim either without doing it, so neither is
 * written until the transaction behind it has been read back from the chain: it must exist, it must
 * have succeeded, and it must have been signed by the wallet asking for the credit. What is left
 * after that is not a claim, it is a record of a public event anyone can check on the explorer.
 *
 * Server-side only. `tx.ts` is the browser half of this and does the opposite job.
 */
import bs58 from "bs58";
import { Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { COOKIE_RPC_URL, PROGRAM_IDS, serverSolanaRpcUrl } from "./config";
import { LAUNCHPAD_IX } from "./expectation";

export type Chain = "cookie" | "solana";

export interface ProvenTransaction {
  tx: VersionedTransactionResponse;
  /** Every address the transaction touched, in order, lookup tables included. */
  keys: string[];
  /** The same addresses, for asking whether one was named at all. */
  accounts: Set<string>;
}

/** One instruction of a confirmed transaction, with its accounts resolved to addresses. */
export interface ProvenInstruction {
  programId: string;
  /** The accounts it was given, in order. */
  accounts: string[];
  /** Its data as hex. An Anchor discriminator is the first eight bytes, so sixteen characters. */
  data: string;
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
 * What the transaction actually ran, instruction by instruction.
 *
 * This is what tells a caller that a transaction really was a launch or a trade on a given pool,
 * rather than any transaction that happens to name the same addresses. Inner instructions are left
 * out on purpose: a programme that calls the launchpad through a CPI is not the launch itself.
 */
export function instructionsOf(proof: ProvenTransaction): ProvenInstruction[] {
  const message = proof.tx.transaction.message as {
    instructions?: { programIdIndex: number; accounts: number[]; data: string }[];
    compiledInstructions?: {
      programIdIndex: number;
      accountKeyIndexes: number[];
      data: Uint8Array;
    }[];
  };
  const at = (i: number) => proof.keys[i] ?? "";

  // A legacy message carries base58 data, a v0 message carries bytes. Both are read here because
  // Cookie Chain serves both and the launchpad's own builds are legacy.
  if (message.compiledInstructions) {
    return message.compiledInstructions.map((ix) => ({
      programId: at(ix.programIdIndex),
      accounts: ix.accountKeyIndexes.map(at),
      data: Buffer.from(ix.data).toString("hex"),
    }));
  }
  return (message.instructions ?? []).map((ix) => ({
    programId: at(ix.programIdIndex),
    accounts: ix.accounts.map(at),
    data: Buffer.from(bs58.decode(ix.data)).toString("hex"),
  }));
}

/**
 * The addresses that signed the transaction.
 *
 * A signature is the one thing nobody can fake with an address alone, so this is what separates
 * "this account appears in the transaction" from "this account took part in it". A freshly minted
 * token signs the transaction that creates it, for instance, and never signs again.
 */
export function signersOf(proof: ProvenTransaction): Set<string> {
  const header = proof.tx.transaction.message.header;
  return new Set(proof.keys.slice(0, header.numRequiredSignatures));
}

/**
 * How much of one token a wallet's accounts gained on this transaction, in raw units, negative when
 * it sold. Summed over every account it owns, and read from the balances the chain recorded, so a
 * trade cannot be claimed for a token the transaction never moved.
 */
export function tokenMoved(proof: ProvenTransaction, owner: string, mint: string): bigint {
  const sum = (
    list: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] | null | undefined,
  ) =>
    (list ?? [])
      .filter((b) => b.owner === owner && b.mint === mint)
      .reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n);

  return sum(proof.tx.meta?.postTokenBalances) - sum(proof.tx.meta?.preTokenBalances);
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

/**
 * Whether this transaction is the one that created this token on the launchpad.
 *
 * Naming the mint is not enough, because every trade on a token names its mint: anyone could point
 * at a stranger's token, call themselves its creator and pick the pair its holders are paid in.
 * So the transaction has to carry the launchpad's own `create_pool` over this mint and pool, and
 * the mint has to have signed it. A mint signs exactly once, in the transaction that brings it into
 * existence, and only whoever holds its key can make it sign at all.
 */
export function createsLaunchpadToken(
  proof: ProvenTransaction,
  mint: string,
  pool: string,
): boolean {
  const created = instructionsOf(proof).some(
    (ix) =>
      ix.programId === PROGRAM_IDS.momoswapLaunchpad &&
      ix.data.startsWith(LAUNCHPAD_IX.create_pool) &&
      ix.accounts.includes(mint) &&
      ix.accounts.includes(pool),
  );
  return created && signersOf(proof).has(mint);
}

/**
 * Whether this transaction traded on a launchpad curve.
 *
 * Curve shares are tracked by the launchpad rather than held as token accounts, so there is no
 * balance movement to read and the instruction itself is the evidence that a trade happened here.
 */
export function tradesOnCurve(proof: ProvenTransaction, pool: string): boolean {
  return instructionsOf(proof).some(
    (ix) =>
      ix.programId === PROGRAM_IDS.momoswapLaunchpad &&
      (ix.data.startsWith(LAUNCHPAD_IX.buy) || ix.data.startsWith(LAUNCHPAD_IX.sell)) &&
      ix.accounts.includes(pool),
  );
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
