"use client";

/**
 * Cookiebox DAMM v2 (a cp-amm fork) liquidity, built in the browser.
 *
 * The Meteora SDK's high-level paths derive PDAs against Meteora's *mainnet* program id, which
 * fails on Cookie Chain's fork with ConstraintSeeds. So the PDAs and instructions here are built
 * against the Cookie program directly, through an Anchor Program loaded from the fork's own IDL.
 * Only the SDK's pure math is reused (liquidity deltas, deposit and withdraw quotes), because that
 * part does not depend on the program id.
 *
 * Everything is non-custodial: this module only *builds* transactions. The user's wallet signs.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";

import cpAmmIdl from "@/idl/cp_amm.json";
import { PROGRAM_IDS } from "./config";
import { CorwaError } from "./http";

export const CP_AMM_PROGRAM_ID = new PublicKey(PROGRAM_IDS.cookieboxDamm);

/** The permissionless PoolConfig create_pool uses by default (quote-only fee mode). */
export const DAMM_CREATE_CONFIG = new PublicKey("HrR3btHfwZ13ceqYD7fUEPfX7Rk6M4i7EgE88abUu5Jc");

const SEED = {
  poolAuthority: Buffer.from("pool_authority"),
  pool: Buffer.from("pool"),
  position: Buffer.from("position"),
  positionNftAccount: Buffer.from("position_nft_account"),
  tokenVault: Buffer.from("token_vault"),
};

// --- PDAs (all derived against the COOKIE program id, not Meteora's) ----------------------------

export function derivePoolAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([SEED.poolAuthority], CP_AMM_PROGRAM_ID)[0];
}

const maxKey = (a: PublicKey, b: PublicKey) =>
  Buffer.compare(a.toBuffer(), b.toBuffer()) >= 0 ? a : b;
const minKey = (a: PublicKey, b: PublicKey) =>
  Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? a : b;

export function derivePoolAddress(config: PublicKey, tokenA: PublicKey, tokenB: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [SEED.pool, config.toBuffer(), maxKey(tokenA, tokenB).toBuffer(), minKey(tokenA, tokenB).toBuffer()],
    CP_AMM_PROGRAM_ID,
  )[0];
}

export function derivePositionAddress(positionNftMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [SEED.position, positionNftMint.toBuffer()],
    CP_AMM_PROGRAM_ID,
  )[0];
}

export function derivePositionNftAccount(positionNftMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [SEED.positionNftAccount, positionNftMint.toBuffer()],
    CP_AMM_PROGRAM_ID,
  )[0];
}

export function deriveTokenVault(mint: PublicKey, pool: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [SEED.tokenVault, mint.toBuffer(), pool.toBuffer()],
    CP_AMM_PROGRAM_ID,
  )[0];
}

// --- Program wiring -------------------------------------------------------------------------------

export interface CpAmmDeps {
  program: Program;
  cpAmm: CpAmm;
  poolAuthority: PublicKey;
  connection: Connection;
}

/**
 * A stand-in for Anchor's `Wallet`.
 *
 * Anchor's browser bundle deliberately omits the Node `Wallet` class (it wraps a keypair file), and
 * a provider here would have nothing to sign with anyway: this module only builds instructions and
 * the user's wallet adapter signs them. So the provider gets a public key and signers that refuse
 * to run - if anything ever tries to sign through Anchor, it should fail loudly rather than
 * silently using a throwaway key.
 */
function readOnlyWallet() {
  const refuse = (): never => {
    throw new CorwaError(
      "Corwa does not sign through Anchor",
      "this provider only builds instructions; the connected wallet signs them",
    );
  };
  return {
    publicKey: Keypair.generate().publicKey,
    signTransaction: refuse,
    signAllTransactions: refuse,
  };
}

/**
 * Anchor needs a provider to construct a Program. Nothing here signs; every transaction leaves
 * this module unsigned.
 */
export function buildDeps(connection: Connection): CpAmmDeps {
  const provider = new AnchorProvider(connection, readOnlyWallet() as never, {
    commitment: "confirmed",
  });
  const program = new Program(
    { ...(cpAmmIdl as unknown as Idl), address: CP_AMM_PROGRAM_ID.toBase58() },
    provider,
  );
  const poolAuthority = derivePoolAuthority();
  const cpAmm = new CpAmm(connection);
  // Point the SDK's math at the Cookie program rather than the mainnet one it was built against.
  Object.assign(cpAmm, { _program: program, poolAuthority });
  return { program, cpAmm, poolAuthority, connection };
}

// --- Token helpers ---------------------------------------------------------------------------------

function ataWithCreateIx(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    owner,
    ata,
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return { ata, ix };
}

/** Native COOK has to be wrapped into a wCOOK account before a pool will take it. */
function wrapNativeIxs(owner: PublicKey, ata: PublicKey, lamports: bigint) {
  return [
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
    createSyncNativeInstruction(ata),
  ];
}

async function resolveMint(conn: Connection, mint: PublicKey) {
  const info = await conn.getParsedAccountInfo(mint);
  const data = info.value?.data;
  if (!info.value || !data || !("parsed" in data)) {
    throw new CorwaError(`mint ${mint.toBase58()} not found on Cookie Chain`);
  }
  return {
    decimals: (data.parsed as { info: { decimals: number } }).info.decimals,
    program: info.value.owner,
  };
}

// --- Pool state ------------------------------------------------------------------------------------

export interface PoolState {
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  sqrtPrice: BN;
  sqrtMinPrice: BN;
  sqrtMaxPrice: BN;
  liquidity: BN;
  collectFeeMode: number;
}

export interface PoolContext {
  deps: CpAmmDeps;
  pool: PublicKey;
  state: PoolState;
  aProgram: PublicKey;
  bProgram: PublicKey;
  aDecimals: number;
  bDecimals: number;
}

export async function loadPool(deps: CpAmmDeps, poolStr: string): Promise<PoolContext> {
  let pool: PublicKey;
  try {
    pool = new PublicKey(poolStr);
  } catch {
    throw new CorwaError(`invalid pool address: ${poolStr}`);
  }

  const info = await deps.connection.getAccountInfo(pool);
  if (!info) throw new CorwaError(`pool ${poolStr} not found on Cookie Chain`);
  if (!info.owner.equals(CP_AMM_PROGRAM_ID)) {
    throw new CorwaError(
      "that pool is not a Cookiebox DAMM v2 pool",
      `it is owned by ${info.owner.toBase58()} - Corwa's LP tools cover DAMM v2 today`,
    );
  }

  const state = (await deps.cpAmm.fetchPoolState(pool)) as unknown as PoolState;
  const [a, b] = await Promise.all([
    resolveMint(deps.connection, state.tokenAMint),
    resolveMint(deps.connection, state.tokenBMint),
  ]);

  return {
    deps,
    pool,
    state,
    aProgram: a.program,
    bProgram: b.program,
    aDecimals: a.decimals,
    bDecimals: b.decimals,
  };
}

// --- Positions ---------------------------------------------------------------------------------------

export interface UserPosition {
  position: PublicKey;
  positionNft: PublicKey;
  positionNftAccount: PublicKey;
  pool: PublicKey;
  unlockedLiquidity: BN;
  vestedLiquidity: BN;
  permanentLockedLiquidity: BN;
  feeAPending: BN;
  feeBPending: BN;
}

interface RawPositionState {
  pool: PublicKey;
  nftMint: PublicKey;
  unlockedLiquidity: BN;
  vestedLiquidity: BN;
  permanentLockedLiquidity: BN;
  feeAPending: BN;
  feeBPending: BN;
}

/**
 * Every DAMM v2 position the wallet holds.
 *
 * Ownership is an NFT: each position mints a Token-2022 NFT, and the position PDA is derived from
 * that mint. So the lookup is "every Token-2022 account of yours holding exactly 1", then a batch
 * fetch of the derived position addresses - anything that decodes is a real position, anything
 * that does not was simply some other NFT.
 */
export async function findUserPositions(
  deps: CpAmmDeps,
  owner: PublicKey,
  pool?: PublicKey,
): Promise<UserPosition[]> {
  const tokenAccounts = await deps.connection.getTokenAccountsByOwner(owner, {
    programId: TOKEN_2022_PROGRAM_ID,
  });

  const candidates: { positionNft: PublicKey; positionNftAccount: PublicKey }[] = [];
  for (const { account, pubkey } of tokenAccounts.value) {
    const decoded = AccountLayout.decode(account.data);
    if (decoded.amount === 1n) {
      candidates.push({ positionNft: new PublicKey(decoded.mint), positionNftAccount: pubkey });
    }
  }
  if (candidates.length === 0) return [];

  const addresses = candidates.map((c) => derivePositionAddress(c.positionNft));
  const namespace = deps.program.account as unknown as Record<
    string,
    { fetchMultiple(a: PublicKey[]): Promise<unknown[]> }
  >;
  const states = (await namespace.position.fetchMultiple(addresses)) as (RawPositionState | null)[];

  const out: UserPosition[] = [];
  candidates.forEach((c, i) => {
    const st = states[i];
    if (!st) return;
    if (pool && !st.pool.equals(pool)) return;
    out.push({
      position: addresses[i],
      positionNft: c.positionNft,
      positionNftAccount: c.positionNftAccount,
      pool: st.pool,
      unlockedLiquidity: st.unlockedLiquidity,
      vestedLiquidity: st.vestedLiquidity,
      permanentLockedLiquidity: st.permanentLockedLiquidity,
      feeAPending: st.feeAPending,
      feeBPending: st.feeBPending,
    });
  });

  const total = (p: UserPosition) =>
    p.unlockedLiquidity.add(p.vestedLiquidity).add(p.permanentLockedLiquidity);
  out.sort((a, b) => (total(b).gt(total(a)) ? 1 : -1));
  return out;
}

// --- Builders ------------------------------------------------------------------------------------------

/**
 * Add liquidity, creating a fresh position.
 *
 * `positionNft` is a new keypair that must co-sign the transaction - it is the mint the position
 * PDA is derived from, so the caller has to keep it and partial-sign before the wallet does.
 */
export async function buildAddLiquidity(args: {
  ctx: PoolContext;
  owner: PublicKey;
  /** UI amount of token A, or null to derive it from B. */
  amountA: number | null;
  amountB: number | null;
  slippageBps: number;
}): Promise<{ transaction: Transaction; positionNft: Keypair; expected: { a: BN; b: BN } }> {
  const { ctx, owner } = args;
  const { program, poolAuthority } = ctx.deps;

  if (args.amountA == null && args.amountB == null) {
    throw new CorwaError("supply an amount for at least one side");
  }

  const isA = args.amountA != null;
  const inputAmount = new BN(
    Math.round((isA ? args.amountA! : args.amountB!) * 10 ** (isA ? ctx.aDecimals : ctx.bDecimals)),
  );

  // The SDK's math is program-id independent, so it is safe to reuse here.
  const liquidityDelta = ctx.deps.cpAmm.getLiquidityDelta({
    maxAmountTokenA: isA ? inputAmount : new BN(0),
    maxAmountTokenB: isA ? new BN(0) : inputAmount,
    sqrtPrice: ctx.state.sqrtPrice,
    sqrtMinPrice: ctx.state.sqrtMinPrice,
    sqrtMaxPrice: ctx.state.sqrtMaxPrice,
  } as never) as BN;

  if (liquidityDelta.lten(0)) {
    throw new CorwaError(
      "that amount is too small to mint any liquidity",
      "try a larger deposit - the pool's price range makes tiny deposits round to zero",
    );
  }

  const quote = ctx.deps.cpAmm.getDepositQuote({
    inAmount: inputAmount,
    isTokenA: isA,
    sqrtPrice: ctx.state.sqrtPrice,
    minSqrtPrice: ctx.state.sqrtMinPrice,
    maxSqrtPrice: ctx.state.sqrtMaxPrice,
  } as never) as { actualInputAmount: BN; outputAmount: BN; liquidityDelta: BN };

  const amountA = isA ? inputAmount : quote.outputAmount;
  const amountB = isA ? quote.outputAmount : inputAmount;

  // Thresholds are the MAX each side may cost, so slippage widens them upward.
  const pad = (v: BN) => v.mul(new BN(10_000 + args.slippageBps)).div(new BN(10_000));
  const maxA = pad(amountA);
  const maxB = pad(amountB);

  const positionNft = Keypair.generate();
  const position = derivePositionAddress(positionNft.publicKey);
  const positionNftAccount = derivePositionNftAccount(positionNft.publicKey);
  const tokenAVault = deriveTokenVault(ctx.state.tokenAMint, ctx.pool);
  const tokenBVault = deriveTokenVault(ctx.state.tokenBMint, ctx.pool);

  const aTa = ataWithCreateIx(ctx.state.tokenAMint, owner, ctx.aProgram);
  const bTa = ataWithCreateIx(ctx.state.tokenBMint, owner, ctx.bProgram);

  const pre: TransactionInstruction[] = [aTa.ix, bTa.ix];
  const post: TransactionInstruction[] = [];

  if (ctx.state.tokenAMint.equals(NATIVE_MINT)) {
    pre.push(...wrapNativeIxs(owner, aTa.ata, BigInt(maxA.toString())));
  }
  if (ctx.state.tokenBMint.equals(NATIVE_MINT)) {
    pre.push(...wrapNativeIxs(owner, bTa.ata, BigInt(maxB.toString())));
  }
  if (ctx.state.tokenAMint.equals(NATIVE_MINT) || ctx.state.tokenBMint.equals(NATIVE_MINT)) {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    // Close the wrapper afterwards so leftover wrapped COOK returns as native.
    post.push(createCloseAccountInstruction(wsol, owner, owner));
  }

  const createPositionIx = await program.methods
    .createPosition()
    .accountsPartial({
      owner,
      positionNftMint: positionNft.publicKey,
      poolAuthority,
      positionNftAccount,
      pool: ctx.pool,
      position,
      payer: owner,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const addIx = await program.methods
    .addLiquidity({
      liquidityDelta,
      tokenAAmountThreshold: maxA,
      tokenBAmountThreshold: maxB,
    })
    .accountsPartial({
      pool: ctx.pool,
      position,
      tokenAAccount: aTa.ata,
      tokenBAccount: bTa.ata,
      tokenAVault,
      tokenBVault,
      tokenAMint: ctx.state.tokenAMint,
      tokenBMint: ctx.state.tokenBMint,
      positionNftAccount,
      owner,
      tokenAProgram: ctx.aProgram,
      tokenBProgram: ctx.bProgram,
    })
    .instruction();

  const transaction = new Transaction().add(createPositionIx, ...pre, addIx, ...post);
  return { transaction, positionNft, expected: { a: amountA, b: amountB } };
}

/** Withdraw a share of a position. `bps` of 10000 removes everything. */
export async function buildRemoveLiquidity(args: {
  ctx: PoolContext;
  owner: PublicKey;
  position: UserPosition;
  bps: number;
}): Promise<Transaction> {
  const { ctx, owner, position } = args;
  const { program, poolAuthority } = ctx.deps;

  const unlocked = position.unlockedLiquidity;
  if (unlocked.lten(0)) {
    throw new CorwaError(
      "this position has no unlocked liquidity to withdraw",
      "vested or permanently locked liquidity cannot be removed",
    );
  }

  const aTa = ataWithCreateIx(ctx.state.tokenAMint, owner, ctx.aProgram);
  const bTa = ataWithCreateIx(ctx.state.tokenBMint, owner, ctx.bProgram);
  const pre = [aTa.ix, bTa.ix];
  const post: TransactionInstruction[] = [];
  if (ctx.state.tokenAMint.equals(NATIVE_MINT) || ctx.state.tokenBMint.equals(NATIVE_MINT)) {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    post.push(createCloseAccountInstruction(wsol, owner, owner));
  }

  const common = {
    poolAuthority,
    pool: ctx.pool,
    position: position.position,
    tokenAAccount: aTa.ata,
    tokenBAccount: bTa.ata,
    tokenAVault: deriveTokenVault(ctx.state.tokenAMint, ctx.pool),
    tokenBVault: deriveTokenVault(ctx.state.tokenBMint, ctx.pool),
    tokenAMint: ctx.state.tokenAMint,
    tokenBMint: ctx.state.tokenBMint,
    positionNftAccount: position.positionNftAccount,
    owner,
    tokenAProgram: ctx.aProgram,
    tokenBProgram: ctx.bProgram,
  };

  const ix =
    args.bps >= 10_000
      ? await program.methods.removeAllLiquidity(new BN(0), new BN(0)).accountsPartial(common).instruction()
      : await program.methods
          .removeLiquidity({
            liquidityDelta: unlocked.mul(new BN(args.bps)).div(new BN(10_000)),
            tokenAAmountThreshold: new BN(0),
            tokenBAmountThreshold: new BN(0),
          })
          .accountsPartial(common)
          .instruction();

  return new Transaction().add(...pre, ix, ...post);
}

/** Sweep the fees a position has accrued. */
export async function buildClaimFees(args: {
  ctx: PoolContext;
  owner: PublicKey;
  position: UserPosition;
}): Promise<Transaction> {
  const { ctx, owner, position } = args;
  const { program, poolAuthority } = ctx.deps;

  const aTa = ataWithCreateIx(ctx.state.tokenAMint, owner, ctx.aProgram);
  const bTa = ataWithCreateIx(ctx.state.tokenBMint, owner, ctx.bProgram);
  const post: TransactionInstruction[] = [];
  if (ctx.state.tokenAMint.equals(NATIVE_MINT) || ctx.state.tokenBMint.equals(NATIVE_MINT)) {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    post.push(createCloseAccountInstruction(wsol, owner, owner));
  }

  const ix = await program.methods
    .claimPositionFee()
    .accountsPartial({
      poolAuthority,
      pool: ctx.pool,
      position: position.position,
      tokenAAccount: aTa.ata,
      tokenBAccount: bTa.ata,
      tokenAVault: deriveTokenVault(ctx.state.tokenAMint, ctx.pool),
      tokenBVault: deriveTokenVault(ctx.state.tokenBMint, ctx.pool),
      tokenAMint: ctx.state.tokenAMint,
      tokenBMint: ctx.state.tokenBMint,
      positionNftAccount: position.positionNftAccount,
      owner,
      tokenAProgram: ctx.aProgram,
      tokenBProgram: ctx.bProgram,
    })
    .instruction();

  return new Transaction().add(aTa.ix, bTa.ix, ix, ...post);
}

/** Convert raw liquidity into the token amounts it currently represents. */
export function positionValue(ctx: PoolContext, position: UserPosition) {
  const total = position.unlockedLiquidity
    .add(position.vestedLiquidity)
    .add(position.permanentLockedLiquidity);

  const quote = ctx.deps.cpAmm.getWithdrawQuote({
    liquidityDelta: total,
    sqrtPrice: ctx.state.sqrtPrice,
    minSqrtPrice: ctx.state.sqrtMinPrice,
    maxSqrtPrice: ctx.state.sqrtMaxPrice,
  } as never) as { outAmountA: BN; outAmountB: BN };

  return {
    amountA: Number(quote.outAmountA.toString()) / 10 ** ctx.aDecimals,
    amountB: Number(quote.outAmountB.toString()) / 10 ** ctx.bDecimals,
    feeA: Number(position.feeAPending.toString()) / 10 ** ctx.aDecimals,
    feeB: Number(position.feeBPending.toString()) / 10 ** ctx.bDecimals,
  };
}

export { BN, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
