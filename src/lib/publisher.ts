/**
 * The server's own vault authority, which publishes epochs without a person.
 *
 * Server only. The key comes from the VAULT_PUBLISHER_KEY secret, never from a file in the repo and
 * never from `.env.local`, because OpenNext bundles that file into the Worker. It is a dedicated
 * key: the program lets the authority publish roots and nothing else, and handing that right to a
 * key that holds no funds of its own keeps a leak to the vault, capped by AUTO_EPOCH_MAX_USD.
 */
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

let cached: { raw: string; keypair: Keypair | null } | null = null;

/** The publisher keypair, or null when this deployment has none. Accepts base58 or a JSON array. */
export function publisherKeypair(): Keypair | null {
  const raw = process.env.VAULT_PUBLISHER_KEY?.trim() ?? "";
  if (cached?.raw === raw) return cached.keypair;

  let keypair: Keypair | null = null;
  if (raw) {
    try {
      const bytes = raw.startsWith("[")
        ? Uint8Array.from(JSON.parse(raw) as number[])
        : bs58.decode(raw);
      keypair = Keypair.fromSecretKey(bytes);
    } catch {
      // A malformed secret is treated as no secret. The status endpoint says so rather than crashing.
      keypair = null;
    }
  }
  cached = { raw, keypair };
  return keypair;
}
