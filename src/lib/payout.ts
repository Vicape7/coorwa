/**
 * Fees a user claims themselves, taken as a stock rather than as they arrive.
 *
 * Nothing here moves money. The payout is the cross-chain buy route with one leg in front of it:
 *
 *   pool or position --[claim fees]--> COOK --[Hyperlane warp]--> COOK (Solana) --[Jupiter]--> xSTOCK
 *
 * so it runs on the same executor and resumes the same way as any route (see
 * `crosschain-exec.ts`). What lives here is the part that decides whether a payout should start at
 * all, because two things would strand COOK on Solana halfway and both can be checked before the
 * first signature: a payout too small to be worth its fixed costs, and a wallet without the SOL the
 * Solana side has to pay.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { STOCK_PAYOUT_MIN_USD, COOK_SOLANA_MINT } from "./config";
import { amount, usd } from "./format";
import type { RouteLeg } from "./crosschain";

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
 * Checked in this order because each answer makes the later ones moot: with nothing owed there is
 * nothing to price, and a payout below the floor is not worth reading the wallet for.
 */
export function payoutBlocked(args: {
  owedCook: number;
  /** What the route says arrives, in USD. Null while it is being priced. */
  valueUsd: number | null;
  sol: SolanaReadiness | null;
}): string | null {
  if (args.owedCook <= 0) return "No fees have accrued yet.";
  if (args.valueUsd === null) return "Pricing the route.";
  if (args.valueUsd < STOCK_PAYOUT_MIN_USD) {
    return (
      `A payout in stock starts at ${usd(STOCK_PAYOUT_MIN_USD)}, and this one would arrive as ` +
      `${usd(args.valueUsd)}. Below that, the fixed costs on Solana take too large a share, so ` +
      "claim the fees as they are instead."
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

// --- Claimed fees --------------------------------------------------------------------------------

/**
 * The COOK a fee claim brought in, in lamports, read off the claim transaction.
 *
 * The claim closes the wallet's wrapped COOK account to unwrap the fees, and closing it also
 * releases whatever that account held before: wrapped COOK the user already had, and its rent.
 * Neither is a fee. So everything the account held before the transaction is taken back out of
 * the wallet's gain, which leaves the fees net of the transaction fee and any rent the claim paid.
 */
export function claimedCook(ownerDelta: bigint, wrappedAccountBefore: bigint): bigint {
  return ownerDelta - wrappedAccountBefore;
}

/**
 * What a payout hands the bridge, in lamports: the claim's COOK plus what a swap leg produced,
 * minus the reserve the bridge transaction pays its fee from. Either part may be absent. The claim's
 * part can be negative when opening a token account cost more than the COOK side paid, and that is
 * counted, so the route never bridges COOK the fees did not bring in.
 */
export function claimToBridge(claimed: bigint, swapped: bigint, reserve: bigint): bigint {
  return claimed + swapped - reserve;
}

// --- Launchpad creator fees ---------------------------------------------------------------------

/**
 * A launchpad creator's fees taken as a stock:
 *
 *   pool --[claim creator fees]--> COOK --[bridge]--> COOK (Solana) --[Jupiter]--> xSTOCK
 *
 * MomoSwap's claim pays wrapped COOK into the creator's own account and closes it in the same
 * transaction, so what it brought in is measured with `claimedCook`.
 */
export interface CreatorClaim {
  pool: string;
}

/** One payout in flight per pool. */
export function creatorPayoutSlug(pool: string): string {
  return `creator:${pool}`;
}

/** The creator fee claim, drawn as the first leg of the route. */
export function creatorClaimLeg(cookFee: number): RouteLeg {
  return {
    kind: "creator-claim",
    label: "Claim your creator fees",
    venue: "MomoSwap launchpad",
    inSymbol: "COOK",
    outSymbol: "COOK",
    inAmount: cookFee,
    outAmount: cookFee,
    priceImpactPct: 0,
    etaSeconds: 5,
    note: "checked against MomoSwap's declaration before you sign",
  };
}
