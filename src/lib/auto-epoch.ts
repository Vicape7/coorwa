/**
 * Publishing epochs without a person.
 *
 * Holders should not wait for an operator to remember them, so the server publishes the next epoch
 * itself once it has run for a day. The steps are the ones the operator panel takes, with the
 * server's publisher key in place of a browser wallet: build the draft, check its proofs, sign and
 * send `publish_epoch`, then read the transaction back and mark the epoch published. Holders still
 * claim their own line, because the program pays only a claimant who signs.
 *
 * Called from the holder sample endpoint, which the scheduler hits every five minutes, so nearly
 * every call ends at "not due yet" after two cheap reads.
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "./db";
import {
  EpochError,
  autoEpochDueAt,
  buildDraft,
  checkTree,
  cookieConnection,
  publishFromChain,
  toCook,
} from "./epochs";
import { publisherKeypair } from "./publisher";
import { epochPda, fetchEpochs, fetchVault, publishEpochIx, vaultPda } from "./vault";
import { AUTO_EPOCH_IN_FLIGHT_MS, AUTO_EPOCH_MAX_USD, VAULT_MINT } from "./config";

const MINT = new PublicKey(VAULT_MINT);

export interface AutoEpochResult {
  published: boolean;
  reason: string;
  index?: string;
  signature?: string;
  totalCook?: number;
  claimants?: number;
}

const skip = (reason: string): AutoEpochResult => ({ published: false, reason });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mark drafts published that already are on chain.
 *
 * A run can land its publish transaction and then fail to record it, for instance when the RPC has
 * not indexed the transaction yet. The chain has moved on to the next index by then, so the draft
 * would sit unrecorded forever and its holders could not claim. The epoch account's own history
 * holds the publish signature, and `publishFromChain` checks the root against it as usual.
 */
async function recordMissedPublishes(epochCount: bigint): Promise<void> {
  if (!db) return;
  const connection = cookieConnection();
  const stale = await db
    .select({ index: schema.epochs.index })
    .from(schema.epochs)
    .where(and(eq(schema.epochs.status, "draft"), lt(schema.epochs.index, epochCount)));

  for (const { index } of stale) {
    const [onChain] = await fetchEpochs(connection, MINT, [index]);
    if (!onChain) continue;
    const history = await connection.getSignaturesForAddress(epochPda(vaultPda(MINT), index), {
      limit: 20,
    });
    // Oldest first: the account was created by the publish, so that is the earliest transaction.
    for (const entry of history.reverse()) {
      if (entry.err) continue;
      try {
        await publishFromChain(entry.signature);
        break;
      } catch {
        // Not the publish, or a root that does not match. The next entry may be it.
      }
    }
  }
}

/** Publish the next epoch if it is due. Never throws for an expected reason to skip. */
export async function runAutoEpoch(now = new Date()): Promise<AutoEpochResult> {
  const signer = publisherKeypair();
  if (!signer) return skip("no VAULT_PUBLISHER_KEY on this deployment");
  if (!db) return skip("no database");

  const connection = cookieConnection();
  const snapshot = await fetchVault(connection, MINT);
  if (!snapshot) return skip("no vault on this chain");
  if (!snapshot.state.authority.equals(signer.publicKey)) {
    return skip(
      `the vault authority is ${snapshot.state.authority.toBase58()}, not the publisher ${signer.publicKey.toBase58()}`,
    );
  }

  await recordMissedPublishes(snapshot.state.epochCount);

  const dueAt = await autoEpochDueAt(now);
  if (!dueAt) return skip("no holder samples since the last epoch");
  if (dueAt > now) return skip(`not due until ${dueAt.toISOString()}`);

  // Another run started a draft a moment ago and may be waiting on its transaction. Rebuilding now
  // would replace the leaves behind a root that is about to land.
  const [pending] = await db
    .select({ createdAt: schema.epochs.createdAt })
    .from(schema.epochs)
    .where(
      and(eq(schema.epochs.index, snapshot.state.epochCount), eq(schema.epochs.status, "draft")),
    )
    .limit(1);
  if (pending && now.getTime() - pending.createdAt.getTime() < AUTO_EPOCH_IN_FLIGHT_MS) {
    return skip("a draft was built moments ago and may still be publishing");
  }

  let draft;
  try {
    draft = await buildDraft({ rebuild: true });
  } catch (e) {
    if (e instanceof EpochError && e.status === 409) return skip(e.message);
    throw e;
  }
  const e = draft.epoch;
  checkTree(BigInt(e.index), draft.lines);

  if (BigInt(draft.shortfallRaw) > 0n) {
    return skip(`the vault is ${draft.shortfallCook} COOK short of epoch ${e.index}`);
  }
  if (e.totalUsd > AUTO_EPOCH_MAX_USD) {
    return skip(
      `epoch ${e.index} pays $${e.totalUsd.toFixed(2)}, above the automatic limit of $${AUTO_EPOCH_MAX_USD}`,
    );
  }

  const tx = new Transaction().add(
    publishEpochIx({
      authority: signer.publicKey,
      mint: MINT,
      index: BigInt(e.index),
      root: Uint8Array.from(Buffer.from(e.root, "hex")),
      total: BigInt(e.totalRaw),
      claimants: e.claimants,
      deadline: Math.floor(new Date(e.deadline).getTime() / 1000),
    }),
  );
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);

  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) {
    throw new Error(
      `publish transaction ${signature} failed: ${JSON.stringify(confirmed.value.err)}`,
    );
  }

  // The RPC can confirm a transaction a moment before it serves it back, so the record retries.
  // If it still fails, the next run finds the draft through the epoch account's history.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await publishFromChain(signature);
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await pause(2000);
    }
  }

  return {
    published: true,
    reason: "published",
    index: e.index,
    signature,
    totalCook: toCook(BigInt(e.totalRaw)),
    claimants: e.claimants,
  };
}
