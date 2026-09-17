/**
 * Checking a swap by what it does to the wallet, for builds whose programmes cannot be read.
 *
 * Coorwa builds no swap of its own. A trade comes back from MomoSwap, Cookiebox, Candy Shop or
 * Jupiter as finished bytes, and somebody's key is asked to sign them: the user's in the terminal
 * and on a claim, the operator's on a payout run. `expectation.ts` can read a launchpad build
 * instruction by instruction because that programme is known; an aggregator route through half a
 * dozen pools is not, and pinning its shape would break on the next route anyway.
 *
 * So this asks the question that holds whoever built it. Simulate the exact bytes, read the two
 * balances the trade is about plus the wallet's own native balance, and refuse anything that spends
 * more than the trade was for, returns less than the quote promised, or helps itself to what is left
 * in the wallet. A build that cannot even simulate is refused first, before it is signed.
 */
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export interface SwapEffect {
  err: unknown;
  /** Units the input balance falls by. */
  spent: bigint;
  /** Units the output balance rises by. */
  received: bigint;
  maxSpend: bigint;
  minReceive: bigint;
  /** Native units the wallet loses outside the trade, and what fees and a new account may cost. */
  nativeSpent: bigint;
  nativeAllowed: bigint;
}

/** Why a simulated swap must not be signed, or null when there is no reason. */
export function swapRefused(e: SwapEffect): string | null {
  if (e.err) return `it fails in simulation: ${JSON.stringify(e.err)}`;
  if (e.spent > e.maxSpend) return `it spends ${e.spent} units, over the ${e.maxSpend} this trade is for`;
  if (e.received < e.minReceive) {
    return `it returns ${e.received} units, under the ${e.minReceive} the quote promised`;
  }
  if (e.nativeSpent > e.nativeAllowed) {
    return `it takes ${e.nativeSpent} of the wallet's own native units, over the ${e.nativeAllowed} fees and rent may cost`;
  }
  return null;
}

/** One side of a trade: the token account it moves through, or the wallet itself for native funds. */
export interface WatchedBalance {
  address: PublicKey;
  native: boolean;
}

export interface SwapWatch {
  input: WatchedBalance;
  output: WatchedBalance;
  /** The wallet that signs, whose native balance pays the fees. */
  owner: PublicKey;
  /** The most the input may fall by, in its own units: what the user or the run is spending. */
  maxSpend: bigint;
  /** The least the output must rise by, which is the quote after the slippage it was given. */
  minReceive: bigint;
  /** What a fee and a token account's rent may cost, in native units. */
  nativeAllowed: bigint;
}

/**
 * Where a mint's balance sits for one wallet: the wallet itself when the mint is the chain's own
 * native token, and the associated account otherwise. COOK on Cookie Chain is native, as SOL is on
 * Solana, so both are named by their wrapped mint and held as plain balance.
 */
export function walletBalance(args: {
  mint: string;
  owner: PublicKey;
  nativeMint: string;
  tokenProgram?: PublicKey;
}): WatchedBalance {
  if (args.mint === args.nativeMint) return { address: args.owner, native: true };
  return {
    address: getAssociatedTokenAddressSync(
      new PublicKey(args.mint),
      args.owner,
      true,
      args.tokenProgram,
    ),
    native: false,
  };
}

/** An SPL or Token-2022 account holds its amount as a little-endian u64 at byte 64. */
export function tokenAmount(data: Buffer | Uint8Array | null | undefined): bigint {
  if (!data || data.length < 72) return 0n;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(64, true);
}

/**
 * Simulate a built swap and say why it must not be signed, or null when it may be.
 *
 * The three accounts read are the ones the trade is about and the one that pays for it. Anything
 * else the transaction touched it would have to name, and a balance it never names it cannot move.
 */
export async function refuseBadSwap(
  conn: Connection,
  tx: VersionedTransaction,
  watch: SwapWatch,
): Promise<string | null> {
  const addresses = [watch.input.address, watch.output.address, watch.owner];
  const before = await conn.getMultipleAccountsInfo(addresses, "confirmed");
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: addresses.map((a) => a.toBase58()) },
  });
  const after = sim.value.accounts ?? [];

  const decoded = (i: number) => {
    const raw = after[i]?.data;
    const encoded = Array.isArray(raw) ? raw[0] : raw;
    return typeof encoded === "string" ? Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)) : null;
  };
  const held = (i: number, native: boolean) =>
    native
      ? [BigInt(before[i]?.lamports ?? 0), BigInt(after[i]?.lamports ?? 0)]
      : [tokenAmount(before[i]?.data), tokenAmount(decoded(i))];

  const [inBefore, inAfter] = held(0, watch.input.native);
  const [outBefore, outAfter] = held(1, watch.output.native);
  const [nativeBefore, nativeAfter] = held(2, true);
  // Native funds pay the fee and any rent out of the same balance the trade moves, so when one side
  // of the trade is the native one the allowance belongs to that side rather than to a third check.
  const touchesNative = watch.input.native || watch.output.native;

  return swapRefused({
    err: sim.value.err,
    spent: inBefore - inAfter,
    received: outAfter - outBefore,
    maxSpend: watch.input.native ? watch.maxSpend + watch.nativeAllowed : watch.maxSpend,
    minReceive: watch.output.native ? watch.minReceive - watch.nativeAllowed : watch.minReceive,
    nativeSpent: touchesNative ? 0n : nativeBefore - nativeAfter,
    nativeAllowed: watch.nativeAllowed,
  });
}
