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
  /** Cashback out of the vault, or the fees on an LP position. Only the wording differs. */
  source?: "cashback" | "lp-fees";
}): string | null {
  const lp = args.source === "lp-fees";
  if (args.rpcIsPublic) {
    return "No dedicated Solana RPC is configured, so the Solana legs cannot be signed from this browser.";
  }
  if (args.owedCook <= 0) return lp ? "No fees have accrued yet." : "Nothing is claimable yet.";
  if (args.valueUsd === null) return "Pricing the route.";
  if (args.valueUsd < CASHBACK_RWA_MIN_USD) {
    return (
      `A payout in stock starts at ${usd(CASHBACK_RWA_MIN_USD)}, and this one would arrive as ` +
      `${usd(args.valueUsd)}. Below that, the fixed costs on Solana take too large a share, so ` +
      (lp ? "claim the fees as they are instead." : "claim it as COOK instead.")
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

// --- LP fees -------------------------------------------------------------------------------------

/**
 * An LP position's fees taken as a stock. The same route again, with the position in front:
 *
 *   position --[claim fees]--> TOKEN + COOK --[Cookie agg, TOKEN side only]--> COOK --[bridge]--> ...
 *
 * Every pool Coorwa manages pairs a token with COOK (28 of 28 on 2026-09-15), so a claim pays at
 * most one side that has to be sold. A pool collecting fees in COOK alone has no swap leg at all.
 */
export interface LpClaim {
  pool: string;
  position: string;
  positionNftAccount: string;
}

/** One payout in flight per position, so two positions in the same pool never share a resume. */
export function lpPayoutSlug(position: string): string {
  return `lp:${position}`;
}

/**
 * The COOK a fee claim brought in, in lamports, read off the claim transaction.
 *
 * The claim closes the wallet's wrapped COOK account to unwrap the fees, and closing it also
 * releases whatever that account held before: wrapped COOK the user already had, and its rent.
 * Neither is a fee. So everything the account held before the transaction is taken back out of
 * the wallet's gain, which leaves the fees net of the transaction fee and any rent the claim paid.
 */
export function lpClaimedCook(ownerDelta: bigint, wrappedAccountBefore: bigint): bigint {
  return ownerDelta - wrappedAccountBefore;
}

/**
 * What an LP payout hands the bridge, in lamports: the claim's COOK plus what the swap produced,
 * minus the reserve the bridge transaction pays its fee from. Either part may be absent. The claim's
 * part can be negative when opening a token account cost more than the COOK side paid, and that is
 * counted, so the route never bridges COOK the fees did not bring in.
 */
export function lpToBridge(claimed: bigint, swapped: bigint, reserve: bigint): bigint {
  return claimed + swapped - reserve;
}

/** The fee claim, drawn as the first leg of the route. */
export function lpClaimLeg(args: {
  cookFee: number;
  /** The non-COOK side, when it has fees at all. */
  token: { symbol: string; amount: number } | null;
}): RouteLeg {
  return {
    kind: "lp-claim",
    label: args.token
      ? `Claim your LP fees in ${args.token.symbol} and COOK`
      : "Claim your LP fees",
    venue: "Cookiebox DAMM v2",
    inSymbol: "COOK",
    outSymbol: "COOK",
    inAmount: args.cookFee,
    outAmount: args.cookFee,
    priceImpactPct: 0,
    etaSeconds: 5,
    note: args.token
      ? `plus ${amount(args.token.amount)} ${args.token.symbol}, sold for COOK next`
      : "this pool pays its fees in COOK",
  };
}

export function proofBytes(hex: string[]): Uint8Array[] {
  return hex.map((h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16)));
}
