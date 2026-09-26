/**
 * Turning a filled-in launch form into transactions.
 *
 * Coorwa's launch program needs no server to build against: the mint is a keypair made in the
 * browser, the instructions are hand-encoded in `launch-program.ts`, and the only thing the app
 * asks a server for is somewhere to put the metadata. So this file is the whole builder, and it
 * runs in the page.
 *
 * Two details it exists to hide. A dev buy spends wrapped COOK, which means wrapping it first and
 * unwrapping the change afterwards, four instructions around the one that matters. And a launch
 * with a dev buy can outgrow a single transaction, which the launchpad used to fail on: here the
 * size is measured before anything is signed and the buy moves into a second transaction only when
 * it has to.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buyIx,
  launchIx,
  quoteBuy,
  sellIx,
  type CurveState,
  type LaunchConfigState,
} from "./launch-program";

/** A legacy transaction's hard limit, signatures included. */
const PACKET_SIZE = 1232;

export interface LaunchFormInput {
  creator: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  /** 100, 200 or 300, whichever tier the creator picked. */
  taxBps: number;
  /** COOK the creator buys on their own curve, in raw units. Zero for none. */
  devBuyQuote: bigint;
  /** The least the dev buy may deliver, from `devBuyQuote` at the opening price less slippage. */
  minBaseOut: bigint;
  /**
   * Whether the creator's wrapped COOK account was created by this transaction, and so should be
   * closed again at the end. False when they already had one, which must be left alone.
   */
  closeWrapped: boolean;
}

/**
 * The curve a launch is about to create, as the program will write it.
 *
 * Quoting a dev buy needs a curve, and the curve does not exist until the launch lands. Every
 * number in it is either fixed by the config or zero on a fresh curve, so it can be stated rather
 * than read, and `quoteBuy` then prices the buy exactly as the program will.
 */
export function openingCurve(
  config: LaunchConfigState,
  input: { mint: PublicKey; creator: PublicKey; taxBps: number },
): CurveState {
  return {
    address: PublicKey.default,
    config: PublicKey.default,
    creator: input.creator,
    mint: input.mint,
    baseVault: PublicKey.default,
    quoteVault: PublicKey.default,
    virtualBase: config.virtualBase,
    virtualQuote: config.virtualQuote,
    saleBase: config.saleBase,
    migrationBase: config.migrationBase,
    graduationQuote: config.graduationQuote,
    baseSold: 0n,
    quoteRaised: 0n,
    feesQuote: 0n,
    taxBps: input.taxBps,
    curveFeeBps: config.curveFeeBps,
    creatorLpShareBps: config.creatorLpShareBps,
    state: "live",
    createdAt: 0,
    positionNftMint: PublicKey.default,
  };
}

/**
 * A curve as the page received it, turned back into the shape the quote functions take.
 *
 * The server sends u64s as strings, because JSON has no integers that wide. Everything else on a
 * curve either prices a trade or names an account, so this is the one place that conversion lives.
 */
export function curveFromSerialised(input: {
  address: string;
  creator: string;
  taxBps: number;
  curveFeeBps: number;
  creatorLpShareBps: number;
  state: "live" | "graduated" | "pooled";
  virtualBase: string;
  virtualQuote: string;
  baseSold: string;
  quoteRaised: string;
  graduationQuote: string;
  saleBase: string;
  migrationBase: string;
  feesQuote: string;
}, mint: string): CurveState {
  return {
    address: new PublicKey(input.address),
    config: PublicKey.default,
    creator: new PublicKey(input.creator),
    mint: new PublicKey(mint),
    baseVault: PublicKey.default,
    quoteVault: PublicKey.default,
    virtualBase: BigInt(input.virtualBase),
    virtualQuote: BigInt(input.virtualQuote),
    saleBase: BigInt(input.saleBase),
    migrationBase: BigInt(input.migrationBase),
    graduationQuote: BigInt(input.graduationQuote),
    baseSold: BigInt(input.baseSold),
    quoteRaised: BigInt(input.quoteRaised),
    feesQuote: BigInt(input.feesQuote),
    taxBps: input.taxBps,
    curveFeeBps: input.curveFeeBps,
    creatorLpShareBps: input.creatorLpShareBps,
    state: input.state,
    createdAt: 0,
    positionNftMint: PublicKey.default,
  };
}

/**
 * The instructions for a trade on a live curve, wrapping and unwrapping COOK around it.
 *
 * The quote side is wrapped COOK, so both directions need that account to exist; a buy funds it
 * from the wallet's own lamports first. It is closed again at the end only when this trade opened
 * it, which is also what pays a seller out in plain COOK rather than leaving it wrapped.
 */
export function tradeInstructions(input: {
  trader: PublicKey;
  mint: PublicKey;
  side: "buy" | "sell";
  /** Quote in for a buy, base in for a sell, in raw units. */
  amount: bigint;
  /** The least the trade may deliver, in raw units of the other side. */
  minOut: bigint;
  closeWrapped: boolean;
}): TransactionInstruction[] {
  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, input.trader);
  const base = getAssociatedTokenAddressSync(
    input.mint,
    input.trader,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const accounts = {
    trader: input.trader,
    mint: input.mint,
    quoteMint: NATIVE_MINT,
    traderBase: base,
    traderQuote: wrapped,
  };

  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      input.trader,
      wrapped,
      input.trader,
      NATIVE_MINT,
    ),
  ];

  if (input.side === "buy") {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: input.trader,
        toPubkey: wrapped,
        lamports: input.amount,
      }),
      createSyncNativeInstruction(wrapped),
      createAssociatedTokenAccountIdempotentInstruction(
        input.trader,
        base,
        input.trader,
        input.mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      buyIx(accounts, input.amount, input.minOut),
    );
  } else {
    instructions.push(sellIx(accounts, input.amount, input.minOut));
  }

  if (input.closeWrapped) {
    instructions.push(createCloseAccountInstruction(wrapped, input.trader, input.trader));
  }
  return instructions;
}

/** What a dev buy of this size delivers on a curve that has not traded yet. */
export function quoteDevBuy(
  config: LaunchConfigState,
  input: { mint: PublicKey; creator: PublicKey; taxBps: number },
  quote: bigint,
) {
  return quoteBuy(openingCurve(config, input), quote);
}

/** Whether the creator already holds a wrapped COOK account, which decides if one is closed later. */
export async function hasWrappedAccount(
  connection: Connection,
  owner: PublicKey,
): Promise<boolean> {
  const account = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  return (await connection.getAccountInfo(account)) !== null;
}

function devBuyInstructions(input: LaunchFormInput): TransactionInstruction[] {
  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, input.creator);
  const base = getAssociatedTokenAddressSync(
    input.mint,
    input.creator,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      input.creator,
      wrapped,
      input.creator,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: input.creator,
      toPubkey: wrapped,
      lamports: input.devBuyQuote,
    }),
    createSyncNativeInstruction(wrapped),
    createAssociatedTokenAccountIdempotentInstruction(
      input.creator,
      base,
      input.creator,
      input.mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    buyIx(
      {
        trader: input.creator,
        mint: input.mint,
        quoteMint: NATIVE_MINT,
        traderBase: base,
        traderQuote: wrapped,
      },
      input.devBuyQuote,
      input.minBaseOut,
    ),
  ];

  // Unwrap whatever the curve did not take, but only out of an account this flow opened. A creator
  // who already held wrapped COOK keeps it wrapped.
  if (input.closeWrapped) {
    instructions.push(
      createCloseAccountInstruction(wrapped, input.creator, input.creator),
    );
  }
  return instructions;
}

/** The size a transaction will be on the wire, signatures included, before it is signed. */
export function transactionSize(tx: Transaction, signers: number): number {
  return tx.compileMessage().serialize().length + 1 + 64 * signers;
}

export interface LaunchPlan {
  /** One transaction, or two when the dev buy does not fit beside the launch. */
  transactions: Transaction[];
  /** True when the buy had to be moved out of the launch transaction. */
  split: boolean;
}

/**
 * Build what the wallet will sign.
 *
 * The launch transaction is signed by the creator and by the mint, which signs exactly once in its
 * life, here. A dev buy rides along when it fits and follows in its own transaction when it does
 * not; either way the wallet is asked once, because both are handed over together.
 */
export function planLaunch(input: LaunchFormInput, blockhash: string): LaunchPlan {
  const launch = launchIx({
    creator: input.creator,
    mint: input.mint,
    quoteMint: NATIVE_MINT,
    name: input.name,
    symbol: input.symbol.toUpperCase(),
    uri: input.uri,
    taxBps: input.taxBps,
  });

  const prepare = (instructions: TransactionInstruction[]) => {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = input.creator;
    tx.recentBlockhash = blockhash;
    return tx;
  };

  if (input.devBuyQuote <= 0n) {
    return { transactions: [prepare([launch])], split: false };
  }

  const buy = devBuyInstructions(input);
  const together = prepare([launch, ...buy]);
  // Two signatures on the launch: the creator and the mint.
  if (transactionSize(together, 2) <= PACKET_SIZE) {
    return { transactions: [together], split: false };
  }
  return { transactions: [prepare([launch]), prepare(buy)], split: true };
}
