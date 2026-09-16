/**
 * Coorwa's fee on a terminal swap, attached to the aggregator's own transaction.
 *
 * Neither Cookie Chain aggregator will pay a referrer, so there is nothing to collect unless Coorwa
 * asks for it directly. It asks in the open: one transfer appended to the transaction the user
 * is about to sign, moving `COORWA_SWAP_FEE_BPS` of the COOK leg to the operator wallet, which pays
 * it out to the token's holders and creator in the pair's asset.
 *
 * Both aggregators hand back a v0 message with no signatures and no address lookup tables, which is
 * what makes appending safe: there is no signature to invalidate and nothing to resolve off chain.
 * Size is the real constraint. A long Candy Shop route came back at 1,144 bytes of the 1,232 a
 * transaction may be, and the fee transfer costs a few dozen bytes. When it does not fit, the swap is returned untouched
 * and unpriced rather than refused: a trade the user asked for is worth more than a fee.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { COOK_MINT, COORWA_OPERATOR, COORWA_SWAP_FEE_BPS } from "./config";

/** The hard limit on a serialized transaction. */
const PACKET_SIZE = 1232;

export interface FeeAttachment {
  transactionBase64: string;
  /** Raw COOK actually charged. Zero means the fee did not fit and nothing was added. */
  feeRaw: string;
  /** Where it went, so the client and the ledger can both check it landed. Empty when unpriced. */
  recipient: string;
}

/** The fee on a COOK leg of this size, in raw units. */
export function swapFeeRaw(cookLegRaw: bigint): bigint {
  return (cookLegRaw * BigInt(COORWA_SWAP_FEE_BPS)) / 10_000n;
}

/**
 * Append the fee to a built swap, or hand the swap back untouched if it will not fit or no operator
 * is configured. The fee is one native COOK transfer to the operator.
 */
export function attachSwapFee(
  transactionBase64: string,
  owner: string,
  cookLegRaw: bigint,
): FeeAttachment {
  const untouched: FeeAttachment = { transactionBase64, feeRaw: "0", recipient: "" };
  if (!COORWA_OPERATOR) return untouched;

  const feeRaw = swapFeeRaw(cookLegRaw);
  if (feeRaw <= 0n) return untouched;

  try {
    const original = VersionedTransaction.deserialize(
      Uint8Array.from(Buffer.from(transactionBase64, "base64")),
    );
    if (original.message.addressTableLookups?.length) return untouched;

    const message = TransactionMessage.decompile(original.message);
    message.instructions.push(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(owner),
        toPubkey: new PublicKey(COORWA_OPERATOR),
        lamports: feeRaw,
      }),
    );

    const rebuilt = new VersionedTransaction(message.compileToV0Message());
    const bytes = rebuilt.serialize();
    if (bytes.length > PACKET_SIZE) return untouched;

    return {
      transactionBase64: Buffer.from(bytes).toString("base64"),
      feeRaw: feeRaw.toString(),
      recipient: COORWA_OPERATOR,
    };
  } catch {
    // A shape this cannot rebuild is a shape it must not mangle. The swap goes through unpriced.
    return untouched;
  }
}

/** Which side of a swap is the COOK leg, if either. A swap between two tokens is not charged. */
export function cookLeg(
  inputMint: string,
  outputMint: string,
  inAmountRaw: string,
  outAmountRaw: string,
): bigint {
  if (inputMint === COOK_MINT) return BigInt(inAmountRaw);
  if (outputMint === COOK_MINT) return BigInt(outAmountRaw);
  return 0n;
}
