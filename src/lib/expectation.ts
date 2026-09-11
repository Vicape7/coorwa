/**
 * Checking a launchpad transaction before the wallet is asked to sign it.
 *
 * MomoSwap builds every launchpad transaction and Coorwa hands it to the user's wallet. Calling that
 * non-custodial only means something if what reaches the wallet is what the user asked for, so this
 * module sits between the two. It runs in the browser, on the exact bytes the wallet will sign, and
 * refuses anything it cannot account for.
 *
 * It asks two questions, in this order:
 *
 * 1. Is this the transaction the launchpad says it built? Every build response carries an
 *    `expectation`: the fee payer, and for each instruction its program, its accounts with their
 *    signer and writable flags, a sha256 of its data, and for a plain COOK transfer the recipient
 *    and the exact amount. The bytes have to match it exactly.
 * 2. Is it what the user asked for? A builder that declares precisely what it built can still have
 *    built the wrong thing, so the declaration proves nothing on its own. Each instruction is read
 *    for itself: only five programs may appear, COOK may only move into the wallet's own wrapped
 *    COOK account and never more than the trade spends, the token program may only sync or close
 *    that same account, and the launchpad instruction has to carry the amount, pool and referrer
 *    the user chose.
 *
 * The launchpad publishes no IDL, on chain or off. Its programme is Anchor, so each discriminator is
 * sha256("global:<name>") and the arguments are borsh. The layouts below were read off real builds,
 * and `tests/expectation.test.ts` pins them against captured responses.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { COOK_DECIMALS, PROGRAM_IDS } from "./config";
import { rawToUi, shortAddr } from "./format";
import type { ExpiryMode } from "./launchpad";

export interface ExpectedAccount {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

export interface ExpectedInstruction {
  programId: string;
  accounts: ExpectedAccount[];
  /** sha256 of the instruction data, in hex. */
  dataHash: string;
  /** Present on a plain COOK transfer: who receives it and exactly how much. */
  transfer?: { to: string; lamports: string };
}

/** What the launchpad says it built, returned next to every transaction it builds. */
export interface Expectation {
  feePayer: string;
  instructions: ExpectedInstruction[];
}

export interface LaunchpadBuild {
  transactionBase64: string;
  expectation?: Expectation;
  /** create only: the token and the curve the launch creates. */
  mint?: string;
  pool?: string;
}

/** What the user asked for, in the raw units the build request was made in. */
export type LaunchpadIntent =
  | { action: "buy"; wallet: string; pool: string; paymentRaw: string; referrer: string | null }
  | { action: "sell"; wallet: string; pool: string; sharesRaw: string }
  | { action: "claim-creator-fees"; wallet: string; pool: string }
  | {
      action: "create";
      wallet: string;
      name: string;
      symbol: string;
      durationSecs: number;
      expiryMode: ExpiryMode;
      devBuyRaw: string | null;
    };

export class BuildMismatchError extends Error {
  constructor(detail: string) {
    super(`Not signed: ${detail}.`);
    this.name = "BuildMismatchError";
  }
}

/**
 * The launchpad's instructions, by Anchor discriminator. The test recomputes each named one from its
 * name, so a typo here fails there rather than refusing every trade.
 */
export const LAUNCHPAD_IX = {
  create_pool: "e992d18ecf6840bc",
  buy: "66063d1201daebea",
  sell: "33e685a4017f83ad",
  claim_creator_fees: "00177dea9c768659",
  /**
   * An instruction with no arguments that the launchpad puts in front of every buy and sell,
   * signed by the trader and touching the pool. Its name is not published and was not among four
   * thousand guesses, so it is pinned by discriminator alone.
   */
  pre_trade: "103c317cdbe481e9",
} as const;

/** The order of the launchpad's expiry modes on the wire. Only "fair" has been seen on a real build. */
const EXPIRY_MODES: ExpiryMode[] = ["dead", "fair", "jackpot", "survivor"];

const LAUNCHPAD = PROGRAM_IDS.momoswapLaunchpad;
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const SYSTEM = SystemProgram.programId.toBase58();
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();

/** SPL token instruction tags. */
const CLOSE_ACCOUNT = 9;
const SYNC_NATIVE = 17;

/**
 * The most a build may bid in priority fees, in lamports (0.001 COOK). MomoSwap sets no price at
 * all today. The cap exists because a compute unit price is the one way a transaction can burn a
 * wallet's COOK without any instruction naming an amount: price times limit is charged whatever the
 * instructions do.
 */
const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
/** What a transaction may use when it sets no compute limit of its own. */
const MAX_COMPUTE_UNITS = 1_400_000n;

/**
 * Check a launchpad build against its own declaration and against what the user asked for.
 * Resolves when both hold and throws a `BuildMismatchError` naming the first thing that does not.
 */
export async function verifyLaunchpadBuild(
  build: LaunchpadBuild,
  intent: LaunchpadIntent,
): Promise<void> {
  const tx = decode(build.transactionBase64);
  const message = TransactionMessage.decompile(tx.message);
  await matchesDeclaration(message, build.expectation);
  matchesIntent(tx, message, build, intent);
}

function decode(base64: string): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  } catch {
    throw new BuildMismatchError("the launchpad returned a transaction that could not be read");
  }
  // Accounts behind a lookup table are resolved on chain, so the bytes alone would not say what
  // the transaction touches. The launchpad has never used one.
  if (tx.message.addressTableLookups?.length) {
    throw new BuildMismatchError(
      "the launchpad's transaction loads accounts from a lookup table, which cannot be checked here",
    );
  }
  return tx;
}

// --- 1. The bytes against the launchpad's declaration -------------------------------------------

async function matchesDeclaration(
  message: TransactionMessage,
  expectation: Expectation | undefined,
): Promise<void> {
  if (!expectation?.instructions) {
    throw new BuildMismatchError(
      "the launchpad did not declare what it built, so there is nothing to check its transaction against",
    );
  }
  const declared = "than the launchpad declared";

  if (message.payerKey.toBase58() !== expectation.feePayer) {
    throw new BuildMismatchError(
      `the launchpad's transaction has a different fee payer ${declared}`,
    );
  }
  if (message.instructions.length !== expectation.instructions.length) {
    throw new BuildMismatchError(
      `the launchpad's transaction has ${message.instructions.length} instructions and the launchpad declared ${expectation.instructions.length}`,
    );
  }

  for (const [i, ix] of message.instructions.entries()) {
    const want = expectation.instructions[i];
    const where = `instruction ${i + 1} of the launchpad's transaction`;

    if (ix.programId.toBase58() !== want.programId) {
      throw new BuildMismatchError(`${where} calls a different program ${declared}`);
    }
    const accounts = ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner}:${k.isWritable}`);
    const wanted = want.accounts.map((a) => `${a.pubkey}:${a.signer}:${a.writable}`);
    if (accounts.join() !== wanted.join()) {
      throw new BuildMismatchError(`${where} touches different accounts ${declared}`);
    }
    if ((await sha256Hex(ix.data)) !== want.dataHash) {
      throw new BuildMismatchError(`${where} carries different data ${declared}`);
    }

    const transfer = readTransfer(ix);
    if (transfer || want.transfer) {
      const same =
        transfer &&
        want.transfer &&
        transfer.to.toBase58() === want.transfer.to &&
        transfer.lamports.toString() === want.transfer.lamports;
      if (!same)
        throw new BuildMismatchError(`${where} moves a different amount of COOK ${declared}`);
    }
  }
}

// --- 2. The bytes against what the user asked for ----------------------------------------------

function matchesIntent(
  tx: VersionedTransaction,
  message: TransactionMessage,
  build: LaunchpadBuild,
  intent: LaunchpadIntent,
): void {
  const wallet = new PublicKey(intent.wallet);

  if (!message.payerKey.equals(wallet)) {
    throw new BuildMismatchError(
      `the launchpad's transaction makes ${shortAddr(message.payerKey.toBase58())} pay its fee instead of your wallet`,
    );
  }

  // The launchpad co-signs a launch with the keys it leased. Anything it has not signed yet would
  // have to be signed by someone later, which is not a transaction the user can sign alone.
  const { header, staticAccountKeys } = tx.message;
  for (let i = 0; i < header.numRequiredSignatures; i++) {
    const key = staticAccountKeys[i];
    if (key.equals(wallet)) continue;
    if (!tx.signatures[i]?.some((b) => b !== 0)) {
      throw new BuildMismatchError(
        `the launchpad's transaction also needs a signature from ${shortAddr(key.toBase58())}`,
      );
    }
  }

  const wrappedCook = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
  // Opening a token account costs its payer rent, so the wallet only ever pays for its own, or for
  // the referrer Coorwa named on a buy (which already has one, so that costs nothing in practice).
  const accountOwners = new Set([intent.wallet]);
  if (intent.action === "buy" && intent.referrer) accountOwners.add(intent.referrer);

  let wrapped = 0n;
  let unitLimit: bigint | null = null;
  let unitPrice = 0n;
  const launchpad: TransactionInstruction[] = [];

  for (const ix of message.instructions) {
    const program = ix.programId.toBase58();

    if (program === COMPUTE_BUDGET) {
      if (ix.data[0] === 2 && ix.data.length === 5) unitLimit = BigInt(u32(ix.data, 1));
      if (ix.data[0] === 3 && ix.data.length === 9) unitPrice = u64(ix.data, 1);
      continue;
    }

    if (program === SYSTEM) {
      const transfer = readTransfer(ix);
      if (!transfer) {
        throw new BuildMismatchError(
          "the launchpad's transaction asks the system program for more than a plain transfer",
        );
      }
      if (!transfer.from.equals(wallet) || !transfer.to.equals(wrappedCook)) {
        throw new BuildMismatchError(
          `the launchpad's transaction sends ${cook(transfer.lamports)} to ${shortAddr(transfer.to.toBase58())}, which is not your own wrapped COOK account`,
        );
      }
      wrapped += transfer.lamports;
      continue;
    }

    if (program === TOKEN) {
      const [account, destination] = ix.keys.map((k) => k.pubkey);
      const own = ix.data.length === 1 && account?.equals(wrappedCook);
      if (own && ix.data[0] === SYNC_NATIVE) continue;
      if (own && ix.data[0] === CLOSE_ACCOUNT && destination?.equals(wallet)) continue;
      throw new BuildMismatchError(
        "the launchpad's transaction asks the token program for more than wrapping and unwrapping your own COOK",
      );
    }

    if (program === ATA) {
      const [payer, account, owner, mint] = ix.keys.map((k) => k.pubkey);
      const create = ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] <= 1);
      if (!create || !payer?.equals(wallet) || !owner || !mint?.equals(NATIVE_MINT)) {
        throw new BuildMismatchError(
          "the launchpad's transaction asks the associated token program for more than opening a COOK account",
        );
      }
      if (!accountOwners.has(owner.toBase58())) {
        throw new BuildMismatchError(
          `the launchpad's transaction opens a token account for ${shortAddr(owner.toBase58())} at your expense`,
        );
      }
      if (!account?.equals(getAssociatedTokenAddressSync(mint, owner, true))) {
        throw new BuildMismatchError(
          "the launchpad's transaction opens a token account at an address that is not the owner's own",
        );
      }
      continue;
    }

    if (program === LAUNCHPAD) {
      launchpad.push(ix);
      continue;
    }

    throw new BuildMismatchError(
      `the launchpad's transaction calls ${shortAddr(program)}, a program a launchpad transaction has no reason to call`,
    );
  }

  const priorityFee = (unitPrice * (unitLimit ?? MAX_COMPUTE_UNITS) + 999_999n) / 1_000_000n;
  if (priorityFee > MAX_PRIORITY_FEE_LAMPORTS) {
    throw new BuildMismatchError(
      `the launchpad's transaction bids up to ${cook(priorityFee)} in priority fees`,
    );
  }

  for (const ix of launchpad) {
    if (!ix.keys[0]?.pubkey.equals(wallet) || !ix.keys[0].isSigner) {
      throw new BuildMismatchError(
        "a launchpad instruction in the transaction acts for a wallet other than yours",
      );
    }
  }

  const spendable = matchesAction(launchpad, build, intent);
  if (wrapped > spendable) {
    throw new BuildMismatchError(
      `the launchpad's transaction wraps ${cook(wrapped)} of your COOK and the ${intent.action} only spends ${cook(spendable)}`,
    );
  }
}

/**
 * The launchpad instructions themselves, for the action that was asked for. Returns how much COOK
 * the action may move out of the wallet, which bounds what the transaction may wrap.
 */
function matchesAction(
  launchpad: TransactionInstruction[],
  build: LaunchpadBuild,
  intent: LaunchpadIntent,
): bigint {
  const byTag = (tag: string) => launchpad.filter((ix) => hex(ix.data.subarray(0, 8)) === tag);
  const only = (...tags: string[]) => {
    if (launchpad.some((ix) => !tags.includes(hex(ix.data.subarray(0, 8))))) {
      throw new BuildMismatchError(
        `the launchpad's transaction runs a launchpad instruction a ${intent.action} does not need`,
      );
    }
  };
  const single = (tag: string, what: string) => {
    const found = byTag(tag);
    if (found.length !== 1) {
      throw new BuildMismatchError(
        `the launchpad's transaction has ${found.length} ${what} instructions where there should be one`,
      );
    }
    return found[0];
  };
  const touching = (ixs: TransactionInstruction[], pool: string) => {
    if (ixs.some((ix) => !ix.keys.some((k) => k.pubkey.toBase58() === pool))) {
      throw new BuildMismatchError(
        `the launchpad's transaction trades on a curve other than ${shortAddr(pool)}`,
      );
    }
  };

  switch (intent.action) {
    case "buy": {
      only(LAUNCHPAD_IX.buy, LAUNCHPAD_IX.pre_trade);
      const buy = readBuy(single(LAUNCHPAD_IX.buy, "buy"));
      touching(launchpad, intent.pool);
      const asked = BigInt(intent.paymentRaw);
      if (buy.payment !== asked) {
        throw new BuildMismatchError(
          `the launchpad's buy spends ${cook(buy.payment)} and you asked to spend ${cook(asked)}`,
        );
      }
      if (buy.referrer !== intent.referrer) {
        throw new BuildMismatchError(
          `the launchpad's buy names ${buy.referrer ? shortAddr(buy.referrer) : "no one"} as referrer instead of ${intent.referrer ? shortAddr(intent.referrer) : "no one"}`,
        );
      }
      return asked;
    }

    case "sell": {
      only(LAUNCHPAD_IX.sell, LAUNCHPAD_IX.pre_trade);
      const sell = single(LAUNCHPAD_IX.sell, "sell");
      touching(launchpad, intent.pool);
      if (sell.data.length !== 16) throw unreadable("sell");
      const shares = u64(sell.data, 8);
      if (shares !== BigInt(intent.sharesRaw)) {
        throw new BuildMismatchError(
          `the launchpad's sell sells ${shares} raw shares and you asked to sell ${intent.sharesRaw}`,
        );
      }
      return 0n;
    }

    case "claim-creator-fees": {
      only(LAUNCHPAD_IX.claim_creator_fees);
      const claim = single(LAUNCHPAD_IX.claim_creator_fees, "claim");
      touching(launchpad, intent.pool);
      if (claim.data.length !== 8) throw unreadable("claim");
      return 0n;
    }

    case "create": {
      only(LAUNCHPAD_IX.create_pool, LAUNCHPAD_IX.buy);
      const create = single(LAUNCHPAD_IX.create_pool, "create");
      if (!build.mint || !build.pool) {
        throw new BuildMismatchError(
          "the launchpad did not say which token and curve it is creating",
        );
      }
      // Coorwa records the benchmark against these two, so they have to be what is really created.
      const mint = create.keys.find((k) => k.pubkey.toBase58() === build.mint);
      if (!mint?.isSigner || !create.keys.some((k) => k.pubkey.toBase58() === build.pool)) {
        throw new BuildMismatchError(
          "the launchpad's transaction creates a different token or curve than the launchpad reported",
        );
      }

      const params = readCreate(create);
      const expiry = EXPIRY_MODES[params.expiry];
      if (params.name !== intent.name || params.symbol !== intent.symbol) {
        throw new BuildMismatchError(
          `the launchpad's transaction launches "${params.name}" (${params.symbol}) and you asked for "${intent.name}" (${intent.symbol})`,
        );
      }
      if (params.durationSecs !== BigInt(intent.durationSecs) || expiry !== intent.expiryMode) {
        throw new BuildMismatchError(
          "the launchpad's transaction opens the curve for a different length of time or with a different ending than you asked for",
        );
      }

      // A dev buy is the creator buying their own curve in the same transaction. The programme
      // refuses self-referral, so it never names a referrer.
      const buys = byTag(LAUNCHPAD_IX.buy);
      if (!intent.devBuyRaw) {
        if (buys.length)
          throw new BuildMismatchError(
            "the launchpad's launch also buys, and you asked for no dev buy",
          );
        return 0n;
      }
      const buy = readBuy(single(LAUNCHPAD_IX.buy, "dev buy"));
      touching(buys, build.pool);
      const asked = BigInt(intent.devBuyRaw);
      if (buy.payment !== asked || buy.referrer !== null) {
        throw new BuildMismatchError(
          `the launchpad's dev buy spends ${cook(buy.payment)} and you asked to spend ${cook(asked)}`,
        );
      }
      return asked;
    }
  }
}

// --- Wire formats --------------------------------------------------------------------------------

/** `buy(payment: u64, referrer: Option<Pubkey>)`. */
function readBuy(ix: TransactionInstruction): { payment: bigint; referrer: string | null } {
  const d = ix.data;
  if (d.length === 17 && d[16] === 0) return { payment: u64(d, 8), referrer: null };
  if (d.length === 49 && d[16] === 1) {
    return { payment: u64(d, 8), referrer: new PublicKey(d.subarray(17, 49)).toBase58() };
  }
  throw unreadable("buy");
}

/**
 * `create_pool`, as far as Coorwa reads it: eight bytes the builder fills differently on every
 * build, then name, symbol and metadata uri as borsh strings, then the launch time, the duration and
 * the expiry mode. What follows (migratable, anti-snipe and three limits) is not checked: the
 * launchpad turns anti-snipe off by itself whenever the launch carries a dev buy, since anti-snipe
 * would refuse the creator's own buy in the first seconds.
 */
function readCreate(ix: TransactionInstruction) {
  const d = ix.data;
  let at = 16;
  const string = () => {
    if (at + 4 > d.length) throw unreadable("create");
    const len = u32(d, at);
    if (len > 200 || at + 4 + len > d.length) throw unreadable("create");
    const s = new TextDecoder().decode(d.subarray(at + 4, at + 4 + len));
    at += 4 + len;
    return s;
  };
  const name = string();
  const symbol = string();
  string(); // metadata uri, pinned by the launchpad
  if (at + 17 > d.length) throw unreadable("create");
  return { name, symbol, durationSecs: u64(d, at + 8), expiry: d[at + 16] };
}

/** A System Program transfer: tag 2, then the amount. */
function readTransfer(ix: TransactionInstruction) {
  if (ix.programId.toBase58() !== SYSTEM || ix.data.length !== 12 || u32(ix.data, 0) !== 2) {
    return null;
  }
  const [from, to] = ix.keys.map((k) => k.pubkey);
  return from && to ? { from, to, lamports: u64(ix.data, 4) } : null;
}

function unreadable(what: string) {
  return new BuildMismatchError(
    `the launchpad's ${what} instruction is not in a shape Coorwa knows how to read`,
  );
}

function view(d: Uint8Array) {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}
const u32 = (d: Uint8Array, at: number) => view(d).getUint32(at, true);
const u64 = (d: Uint8Array, at: number) => view(d).getBigUint64(at, true);

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(d: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(d))));
}

const cook = (lamports: bigint) => `${rawToUi(lamports, COOK_DECIMALS)} COOK`;
