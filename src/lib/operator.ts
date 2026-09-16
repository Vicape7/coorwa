/**
 * The operator's key, which pays holder rewards.
 *
 * Server only. The key comes from the COORWA_OPERATOR_KEY secret, never from a file in the repo and
 * never from `.env.local`, because OpenNext bundles that file into the Worker. It has to match
 * NEXT_PUBLIC_COORWA_OPERATOR, the address every fee is paid to, or it is refused: a key for some
 * other wallet would run payouts against money that is not there.
 */
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { COORWA_OPERATOR } from "./config";

let cached: { raw: string; keypair: Keypair | null } | null = null;

/** The operator keypair, or null when this deployment has none. Accepts base58 or a JSON array. */
export function operatorKeypair(): Keypair | null {
  const raw = process.env.COORWA_OPERATOR_KEY?.trim() ?? "";
  if (cached?.raw === raw) return cached.keypair;

  let keypair: Keypair | null = null;
  if (raw) {
    try {
      const bytes = raw.startsWith("[")
        ? Uint8Array.from(JSON.parse(raw) as number[])
        : bs58.decode(raw);
      const candidate = Keypair.fromSecretKey(bytes);
      keypair = candidate.publicKey.toBase58() === COORWA_OPERATOR ? candidate : null;
    } catch {
      keypair = null;
    }
  }
  cached = { raw, keypair };
  return keypair;
}
