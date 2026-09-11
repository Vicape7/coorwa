/**
 * Cashback taken as a stock rather than as COOK.
 *
 * Nothing here moves money. The payout is the cross-chain buy route with one leg in front of it:
 *
 *   vault --[claim]--> COOK --[Hyperlane warp]--> COOK (Solana) --[Jupiter]--> xSTOCK
 *
 * so it runs on the same executor and resumes the same way as any settlement (see
 * `crosschain-exec.ts`). What lives here is the part that decides whether a payout should start at
 * all, because two things would strand COOK on Solana halfway and both can be checked before the
 * first signature: a payout too small to be worth its fixed costs, and a wallet without the SOL the
 * Solana side has to pay.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CASHBACK_RWA_MIN_USD, COOK_SOLANA_MINT } from "./config";
import { amount, usd } from "./format";
import type { RouteLeg } from "./crosschain";

/** A payout is stored as a journey like any route, under this in place of a pair. */
export const PAYOUT_SLUG = "cashback";

/** One open epoch, carried on the journey so a resumed payout claims exactly what it started with. */
export interface PayoutClaim {
  epoch: string;
  amountRaw: string;
  /** Sibling hashes, leaf upwards, as hex. */
  proof: string[];
}

/**
 * Rent for the two token accounts a first payout opens on Solana, in lamports, measured on mainnet
 * on 2026-09-11. Bridged COOK is Token-2022 at 170 bytes an account; an xStock account carries more
 * extensions and is 179. Rent is a function of size alone, so these only move if Solana changes it.
 */
const COOK_ACCOUNT_RENT = 1_887_234;
const RWA_ACCOUNT_RENT = 1_944_231;
/**
 * Transaction fees on the Solana side, with room to spare: the account the bridge needs and the
 * Jupiter swap are two transactions at 5,000 lamports a signature, and priority fees were zero when
 * this was measured. Half a thousandth of a SOL covers that many times over.
 */
const SOLANA_FEES = 500_000;

export interface SolanaReadiness {
  /** SOL in the wallet on Solana. */
  balance: number;
  /** SOL the payout will need there. */
  needed: number;
  /** Token accounts the payout has to open, which is most of `needed` the first time. */
  newAccounts: number;
}

/** What the Solana side will cost, given which of the two accounts the wallet already has. */
export function solNeeded(has: { cookAccount: boolean; rwaAccount: boolean }): number {
  const lamports =
    SOLANA_FEES +
    (has.cookAccount ? 0 : COOK_ACCOUNT_RENT) +
    (has.rwaAccount ? 0 : RWA_ACCOUNT_RENT);
  return lamports / 1e9;
}

/** Read the wallet's SOL and its two token accounts on Solana. Both mints are Token-2022. */
export async function solanaReadiness(
  conn: Connection,
  owner: PublicKey,
  rwaMint: string,
): Promise<SolanaReadiness> {
  const ata = (mint: string) =>
    getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, TOKEN_2022_PROGRAM_ID);
  const [lamports, [cook, rwa]] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    conn.getMultipleAccountsInfo([ata(COOK_SOLANA_MINT), ata(rwaMint)], "confirmed"),
  ]);
  const has = { cookAccount: cook !== null, rwaAccount: rwa !== null };
  return {
    balance: lamports / 1e9,
    needed: solNeeded(has),
    newAccounts: Number(!has.cookAccount) + Number(!has.rwaAccount),
  };
}

/**
 * Why a payout cannot start yet, in the words the page shows, or null when it can.
 *
 * Checked in this order because each answer makes the later ones moot: with no Solana RPC nothing
 * can be signed there at all, with nothing owed there is nothing to price, and a payout below the
 * floor is not worth reading the wallet for.
 */
export function payoutBlocked(args: {
  rpcIsPublic: boolean;
  owedCook: number;
  /** What the route says arrives, in USD. Null while it is being priced. */
  valueUsd: number | null;
  sol: SolanaReadiness | null;
}): string | null {
  if (args.rpcIsPublic) {
    return "No dedicated Solana RPC is configured, so the Solana legs cannot be signed from this browser.";
  }
  if (args.owedCook <= 0) return "Nothing is claimable yet.";
  if (args.valueUsd === null) return "Pricing the route.";
  if (args.valueUsd < CASHBACK_RWA_MIN_USD) {
    return (
      `A payout in stock starts at ${usd(CASHBACK_RWA_MIN_USD)}, and this one would arrive as ` +
      `${usd(args.valueUsd)}. Below that, the fixed costs on Solana take too large a share, so ` +
      "claim it as COOK instead."
    );
  }
  if (!args.sol) return "Checking your SOL on Solana.";
  if (args.sol.balance < args.sol.needed) {
    const accounts =
      args.sol.newAccounts > 0
        ? ` and ${args.sol.newAccounts} new token account${args.sol.newAccounts > 1 ? "s" : ""}`
        : "";
    return (
      `The Solana side needs about ${amount(args.sol.needed, 4)} SOL in this wallet for fees` +
      `${accounts}, and it holds ${amount(args.sol.balance, 4)}. Add SOL first. Nothing has been signed.`
    );
  }
  return null;
}

/**
 * What a claim leg hands the bridge, in lamports.
 *
 * `gained` is the wallet's native COOK after the claims minus before them, so it is already net of
 * every fee and rent the claims cost. It is capped at what the epochs owe, so COOK that arrived for
 * some other reason in the meantime is never swept into the payout, and `reserve` stays behind to
 * pay for the bridge transaction itself. Zero or less means there is nothing worth bridging.
 */
export function claimedToBridge(gained: bigint, owed: bigint, reserve: bigint): bigint {
  return (gained < owed ? gained : owed) - reserve;
}

/** The claim, drawn as the first leg of the route. */
export function claimLeg(owedCook: number): RouteLeg {
  return {
    kind: "claim",
    label: "Claim your cashback",
    venue: "Coorwa vault",
    inSymbol: "COOK",
    outSymbol: "COOK",
    inAmount: owedCook,
    outAmount: owedCook,
    priceImpactPct: 0,
    etaSeconds: 5,
    note: "one signature per open epoch",
  };
}

export function proofBytes(hex: string[]): Uint8Array[] {
  return hex.map((h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16)));
}
