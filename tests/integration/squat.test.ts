/**
 * A pool opened on a token's graduation address before its curve fills.
 *
 * The pool program derives a pool's address from its config and its two mints, and the config
 * Coorwa graduates into lets anyone open a pool on it. So anyone holding a few of a token's units can
 * open that token's pool first, at whatever price and in whichever token order they like, and the
 * address `graduate` was going to create is taken. This suite does exactly that, as a stranger,
 * against the real pool program, and then graduates anyway through `graduate_into_pool`: trade the
 * squatter's pool back to the curve's price, deposit, lock.
 *
 * Run by `npm run program:test`, like the rest of `tests/integration`.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DAMM_CONFIG,
  DAMM_POOL_AUTHORITY,
  DAMM_PROGRAM_ID,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  baseVault,
  buyIx,
  claimPoolFeesIx,
  dammEventAuthority,
  dammPoolPda,
  dammPositionNftAccount,
  dammPositionPda,
  dammTokenVault,
  decodeDammPool,
  existingPoolGraduation,
  fetchCurve,
  fetchLaunchConfig,
  graduateIntoPoolIx,
  graduateIx,
  graduationParams,
  initializeConfigIx,
  launchIx,
  quoteVault,
  vaultAuthorityPda,
} from "../../src/lib/launch-program";
import { planGraduation, sendGraduation } from "../../src/lib/graduation-crank";

const RPC = process.env.COORWA_TEST_RPC ?? "http://127.0.0.1:8899";
const UNIT = 10n ** 6n;

const connection = new Connection(RPC, "confirmed");
const creator = Keypair.generate();
const trader = Keypair.generate();
const stranger = Keypair.generate();

async function fund(key: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/** The program logs a transaction's refusal; this pulls the part a test can match on. */
function logsOf(e: unknown): string {
  return ((e as { transactionLogs?: string[] }).transactionLogs ?? []).join("\n");
}

async function wrap(owner: Keypair, sol: number): Promise<PublicKey> {
  const account = getAssociatedTokenAddressSync(NATIVE_MINT, owner.publicKey);
  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        account,
        owner.publicKey,
        NATIVE_MINT,
      ),
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: account,
        lamports: Math.floor(sol * LAMPORTS_PER_SOL),
      }),
      createSyncNativeInstruction(account),
    ],
    [owner],
  );
  return account;
}

const baseAta = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
const quoteAta = (owner: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);

async function launch(): Promise<PublicKey> {
  const mint = Keypair.generate();
  await send(
    [
      launchIx({
        creator: creator.publicKey,
        mint: mint.publicKey,
        quoteMint: NATIVE_MINT,
        name: "Squatted",
        symbol: "SQT",
        uri: "https://coorwa.fun/t/squatted.json",
        taxBps: 300,
      }),
    ],
    [creator, mint],
  );
  return mint.publicKey;
}

async function buy(who: Keypair, mint: PublicKey, lamports: bigint) {
  const traderBase = baseAta(mint, who.publicKey);
  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(
        who.publicKey,
        traderBase,
        who.publicKey,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      buyIx(
        {
          trader: who.publicKey,
          mint,
          quoteMint: NATIVE_MINT,
          traderBase,
          traderQuote: quoteAta(who.publicKey),
        },
        lamports,
        0n,
      ),
    ],
    [who],
  );
}

const u64le = (v: bigint) => Buffer.from(new BigUint64Array([v]).buffer);
const u128le = (v: bigint) =>
  Buffer.from(new BigUint64Array([v & 0xffffffffffffffffn, v >> 64n]).buffer);
const m = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});
const programOf = (mint: PublicKey, token: PublicKey) =>
  token.equals(mint) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

/**
 * Open the graduation pool of `mint` as `who`, straight on the pool program, the way anyone could.
 * `sqrtPrice` is sqrt(quote per base); `baseIsA` picks the order, and the address is the same either
 * way.
 */
async function squat(args: {
  who: Keypair;
  mint: PublicKey;
  sqrtPrice: bigint;
  quoteIn: bigint;
  baseIsA: boolean;
  activationPoint?: bigint;
}) {
  const { who, mint } = args;
  const pool = dammPoolPda(mint, NATIVE_MINT);
  const nft = Keypair.generate();
  const [tokenA, tokenB] = args.baseIsA ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint];
  // The pool's price is always B per A, so the other order stores the inverse.
  const sqrtPrice = args.baseIsA ? args.sqrtPrice : ((1n << 128n) - 1n) / args.sqrtPrice;
  const liquidity = args.baseIsA
    ? (args.quoteIn << 128n) / (sqrtPrice - MIN_SQRT_PRICE)
    : (args.quoteIn * sqrtPrice * MAX_SQRT_PRICE) / (MAX_SQRT_PRICE - sqrtPrice);
  const payerOf = (t: PublicKey) => (t.equals(mint) ? baseAta(mint, who.publicKey) : quoteAta(who.publicKey));
  const activation =
    args.activationPoint === undefined
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), u64le(args.activationPoint)]);

  await send(
    [
      new TransactionInstruction({
        programId: DAMM_PROGRAM_ID,
        keys: [
          m(who.publicKey),
          m(nft.publicKey, true, true),
          m(dammPositionNftAccount(nft.publicKey), false, true),
          m(who.publicKey, true, true),
          m(DAMM_CONFIG),
          m(DAMM_POOL_AUTHORITY),
          m(pool, false, true),
          m(dammPositionPda(nft.publicKey), false, true),
          m(tokenA),
          m(tokenB),
          m(dammTokenVault(tokenA, pool), false, true),
          m(dammTokenVault(tokenB, pool), false, true),
          m(payerOf(tokenA), false, true),
          m(payerOf(tokenB), false, true),
          m(programOf(mint, tokenA)),
          m(programOf(mint, tokenB)),
          m(TOKEN_2022_PROGRAM_ID),
          m(SystemProgram.programId),
          m(dammEventAuthority()),
          m(DAMM_PROGRAM_ID),
        ],
        data: Buffer.concat([
          Buffer.from([95, 180, 10, 172, 84, 174, 232, 40]),
          u128le(liquidity),
          u128le(sqrtPrice),
          activation,
        ]),
      }),
    ],
    [who, nft],
  );
  return pool;
}

/** A trade on the pool itself, quote in, the way any trader would make one after graduation. */
async function tradePool(who: Keypair, mint: PublicKey, quoteIn: bigint) {
  const pool = dammPoolPda(mint, NATIVE_MINT);
  const state = decodeDammPool((await connection.getAccountInfo(pool))!.data);
  const [tokenA, tokenB] = [state.tokenAMint, state.tokenBMint];
  await send(
    [
      new TransactionInstruction({
        programId: DAMM_PROGRAM_ID,
        keys: [
          m(DAMM_POOL_AUTHORITY),
          m(pool, false, true),
          m(quoteAta(who.publicKey), false, true),
          m(baseAta(mint, who.publicKey), false, true),
          m(dammTokenVault(tokenA, pool), false, true),
          m(dammTokenVault(tokenB, pool), false, true),
          m(tokenA),
          m(tokenB),
          m(who.publicKey, true),
          m(programOf(mint, tokenA)),
          m(programOf(mint, tokenB)),
          m(DAMM_PROGRAM_ID),
          m(dammEventAuthority()),
          m(DAMM_PROGRAM_ID),
        ],
        data: Buffer.concat([
          Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
          u64le(quoteIn),
          u64le(0n),
        ]),
      }),
    ],
    [who],
  );
}

/** Fill the curve to its target, which is what makes it ready to graduate. */
async function fill(mint: PublicKey) {
  const curve = await fetchCurve(connection, mint);
  assert.ok(curve);
  await buy(trader, mint, (curve.graduationQuote - curve.quoteRaised) * 2n);
  assert.equal((await fetchCurve(connection, mint))?.state, "graduated");
}

const rent = (mint: PublicKey) =>
  SystemProgram.transfer({
    fromPubkey: trader.publicKey,
    toPubkey: vaultAuthorityPda(mint),
    lamports: Math.floor(0.2 * LAMPORTS_PER_SOL),
  });

async function graduateFresh(mint: PublicKey) {
  const curve = await fetchCurve(connection, mint);
  assert.ok(curve);
  const vault = (await getAccount(connection, baseVault(mint), "confirmed", TOKEN_2022_PROGRAM_ID))
    .amount;
  const params = graduationParams(curve, vault);
  const nft = Keypair.generate();
  return send(
    [
      rent(mint),
      graduateIx({
        mint,
        quoteMint: NATIVE_MINT,
        positionNftMint: nft.publicKey,
        liquidity: params.liquidity,
        sqrtPrice: params.sqrtPrice,
      }),
    ],
    [trader, nft],
  );
}

/** What the curve holds right now, the quote its own fees are not part of. */
async function held(mint: PublicKey) {
  const curve = await fetchCurve(connection, mint);
  assert.ok(curve);
  const base = (await getAccount(connection, baseVault(mint), "confirmed", TOKEN_2022_PROGRAM_ID))
    .amount;
  const quote = (await getAccount(connection, quoteVault(mint, NATIVE_MINT))).amount;
  return { curve, base, quote: quote - curve.feesQuote };
}

async function graduateInto(mint: PublicKey, override?: { liquidity?: bigint }) {
  const { curve, base, quote } = await held(mint);
  const pool = decodeDammPool((await connection.getAccountInfo(dammPoolPda(mint, NATIVE_MINT)))!.data);
  const plan = existingPoolGraduation(curve, pool, { base, quote });
  const nft = Keypair.generate();
  await send(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      rent(mint),
      graduateIntoPoolIx({
        mint,
        quoteMint: NATIVE_MINT,
        positionNftMint: nft.publicKey,
        swapIn: plan.swapIn,
        liquidity: override?.liquidity ?? plan.liquidity,
      }),
    ],
    [trader, nft],
  );
  return { plan, nft: nft.publicKey };
}

/** sqrt(quote per base) the curve closes at, Q64.64, as `graduate` would open its pool. */
async function closingSqrtPrice(mint: PublicKey): Promise<bigint> {
  const curve = await fetchCurve(connection, mint);
  const config = await fetchLaunchConfig(connection);
  assert.ok(curve && config);
  return graduationParams({ ...curve, quoteRaised: config.graduationQuote }).sqrtPrice;
}

/** Everything a graduation into a squatted pool has to leave behind. */
async function assertGraduated(mint: PublicKey, plan: { targetSqrtPrice: bigint; liquidity: bigint }, nft: PublicKey) {
  const curve = await fetchCurve(connection, mint);
  assert.ok(curve);
  assert.equal(curve.state, "pooled");
  assert.equal(curve.positionNftMint.toBase58(), nft.toBase58());

  const pool = decodeDammPool((await connection.getAccountInfo(dammPoolPda(mint, NATIVE_MINT)))!.data);
  const gap = pool.sqrtPrice > plan.targetSqrtPrice
    ? pool.sqrtPrice - plan.targetSqrtPrice
    : plan.targetSqrtPrice - pool.sqrtPrice;
  assert.ok(gap * 100n <= plan.targetSqrtPrice, "the pool ends at the curve's price");

  const position = (await connection.getAccountInfo(dammPositionPda(nft)))!.data;
  const read128 = (at: number) => position.readBigUInt64LE(at) | (position.readBigUInt64LE(at + 8) << 64n);
  assert.equal(read128(152), 0n, "nothing unlocked");
  assert.equal(read128(184), plan.liquidity, "all of the curve's liquidity locked for good");

  const base = await getAccount(connection, baseVault(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(base.amount, 0n, "base the pool did not take is burned");
  const quote = await getAccount(connection, quoteVault(mint, NATIVE_MINT));
  assert.equal(quote.amount, curve.feesQuote, "no quote is stranded outside the fees");

  // The COOK the curve raised ended up in the pool, whichever way the squatter mispriced it.
  const poolQuote = await getAccount(connection, dammTokenVault(NATIVE_MINT, dammPoolPda(mint, NATIVE_MINT)));
  assert.ok(
    poolQuote.amount * 100n >= curve.quoteRaised * 99n,
    `the pool holds ${poolQuote.amount} of the ${curve.quoteRaised} raised`,
  );
}

before(async () => {
  await fund(creator.publicKey, 10);
  await fund(trader.publicKey, 200);
  await fund(stranger.publicKey, 10);
  await wrap(trader, 160);
  await wrap(stranger, 2);

  // The config is one per program. The launch suite may have written it already; if not, the same
  // numbers are written here, with a graduation small enough for a test wallet to reach.
  if (!(await fetchLaunchConfig(connection))) {
    // A multiple of three, for the reason the launch suite gives.
    const graduationQuote = 12n * BigInt(LAMPORTS_PER_SOL);
    await send(
      [
        initializeConfigIx(creator.publicKey, NATIVE_MINT, {
          feeRecipient: creator.publicKey,
          withholdAuthority: creator.publicKey,
          curveFeeBps: 100,
          creatorLpShareBps: 4000,
          taxTiers: [100, 200, 300, 0],
          graduationQuote,
          saleBase: 800_000_000n * UNIT,
          migrationBase: 200_000_000n * UNIT,
          virtualQuote: graduationQuote / 3n,
          virtualBase: (800_000_000n * UNIT * 4n) / 3n,
          tokenDecimals: 6,
          paused: false,
          dammConfig: DAMM_CONFIG,
        }),
      ],
      [creator],
    );
  }
});

test("a squatted pool priced too high: graduate is refused, graduate_into_pool sells it down", async () => {
  const mint = await launch();
  await buy(stranger, mint, BigInt(LAMPORTS_PER_SOL / 10));
  // A hundred times the curve's closing price, with a hundredth of a COOK behind it.
  const close = await closingSqrtPrice(mint);
  await squat({ who: stranger, mint, sqrtPrice: close * 10n, quoteIn: 10_000_000n, baseIsA: true });
  await fill(mint);

  await assert.rejects(graduateFresh(mint), (e) => /already in use/.test(logsOf(e)));
  const { plan, nft } = await graduateInto(mint);
  assert.ok(plan.sellsBase && plan.swapIn > 0n);
  await assertGraduated(mint, plan, nft);
});

test("a squatted pool priced too low: graduate_into_pool buys it up", async () => {
  const mint = await launch();
  await buy(stranger, mint, BigInt(LAMPORTS_PER_SOL / 10));
  const close = await closingSqrtPrice(mint);
  await squat({ who: stranger, mint, sqrtPrice: close / 10n, quoteIn: 1_000_000n, baseIsA: true });
  await fill(mint);

  const { plan, nft } = await graduateInto(mint);
  assert.ok(!plan.sellsBase && plan.swapIn > 0n);
  await assertGraduated(mint, plan, nft);
});

test("a squatted pool with the quote first, and its fees still split", async () => {
  const mint = await launch();
  await buy(stranger, mint, BigInt(LAMPORTS_PER_SOL / 10));
  const close = await closingSqrtPrice(mint);
  const pool = await squat({ who: stranger, mint, sqrtPrice: close * 3n, quoteIn: 5_000_000n, baseIsA: false });
  const info = await connection.getAccountInfo(pool);
  assert.equal(new PublicKey(info!.data.subarray(168, 200)).toBase58(), NATIVE_MINT.toBase58());
  await fill(mint);

  const { plan, nft } = await graduateInto(mint);
  assert.equal(plan.baseIsA, false);
  await assertGraduated(mint, plan, nft);

  // A trade on the pool earns the locked position a fee, which in this order is paid in the base.
  await tradePool(stranger, mint, 100_000_000n);
  const config = await fetchLaunchConfig(connection);
  assert.ok(config);
  const creatorBase = baseAta(mint, creator.publicKey);
  const platformBase = baseAta(mint, config.feeRecipient);
  const creatorQuote = quoteAta(creator.publicKey);
  const platformQuote = quoteAta(config.feeRecipient);
  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, creatorBase, creator.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, platformBase, config.feeRecipient, mint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, creatorQuote, creator.publicKey, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, platformQuote, config.feeRecipient, NATIVE_MINT),
    ],
    [trader],
  );
  const before = (await getAccount(connection, creatorBase, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  await send(
    [
      claimPoolFeesIx({
        mint,
        quoteMint: NATIVE_MINT,
        creator: creator.publicKey,
        positionNftMint: nft,
        creatorQuote,
        platformQuote,
        creatorBase,
        platformBase,
      }),
    ],
    [trader],
  );
  const after = (await getAccount(connection, creatorBase, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  assert.ok(after > before, "the creator's share of the pool's fee arrived, in the base");
});

test("a caller cannot graduate by depositing a sliver and burning the rest", async () => {
  const mint = await launch();
  await buy(stranger, mint, BigInt(LAMPORTS_PER_SOL / 10));
  const close = await closingSqrtPrice(mint);
  await squat({ who: stranger, mint, sqrtPrice: close * 2n, quoteIn: 10_000_000n, baseIsA: true });
  await fill(mint);

  const { curve, base, quote } = await held(mint);
  const pool = decodeDammPool((await connection.getAccountInfo(dammPoolPda(mint, NATIVE_MINT)))!.data);
  const honest = existingPoolGraduation(curve, pool, { base, quote });
  await assert.rejects(
    graduateInto(mint, { liquidity: honest.liquidity / 100n }),
    (e) => /SeedOutOfRange/.test(logsOf(e)),
  );
  assert.equal((await fetchCurve(connection, mint))?.state, "graduated", "and nothing moved");
});

test("a squatter can delay the first trade by a month at most, and graduation waits for it", async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const mint = await launch();
  await buy(stranger, mint, BigInt(LAMPORTS_PER_SOL / 20));
  const close = await closingSqrtPrice(mint);

  // The pool program refuses a first trade further out than about a month.
  await assert.rejects(
    squat({ who: stranger, mint, sqrtPrice: close * 2n, quoteIn: 5_000_000n, baseIsA: true, activationPoint: now + 32n * 86_400n }),
  );
  await squat({ who: stranger, mint, sqrtPrice: close * 2n, quoteIn: 5_000_000n, baseIsA: true, activationPoint: now + 30n * 86_400n });
  await fill(mint);

  // The pool program will not trade a pool before its first trade is due, so neither can we.
  await assert.rejects(graduateInto(mint), (e) => /PoolDisabled/.test(logsOf(e)));
  assert.equal((await fetchCurve(connection, mint))?.state, "graduated", "still waiting, nothing lost");
});

// --- the crank's own plan ----------------------------------------------------------------------

/** Graduate the way the scheduler does: measure, then send exactly what was measured. */
async function crank(mint: PublicKey) {
  const curve = await fetchCurve(connection, mint);
  assert.ok(curve);
  const plan = await planGraduation(connection, curve, trader.publicKey);
  if (!("instructions" in plan)) return plan;
  const signature = await sendGraduation(connection, plan, trader);
  return { ...plan, signature };
}

test("the crank graduates a clean curve and leaves nothing in the vault authority", async () => {
  const mint = await launch();
  await fill(mint);
  const done = await crank(mint);
  assert.equal(done.kind, "fresh");
  assert.equal((await fetchCurve(connection, mint))?.state, "pooled");
  assert.equal(await connection.getBalance(vaultAuthorityPda(mint)), 0, "the rent sent was the rent used");
});

test("the crank finds a squatted pool and graduates into it", async () => {
  const mint = await launch();
  await buy(stranger, mint, BigInt(LAMPORTS_PER_SOL / 10));
  const close = await closingSqrtPrice(mint);
  await squat({ who: stranger, mint, sqrtPrice: close * 4n, quoteIn: 10_000_000n, baseIsA: false });
  await fill(mint);
  const done = await crank(mint);
  assert.equal(done.kind, "into");
  assert.equal((await fetchCurve(connection, mint))?.state, "pooled");
  assert.equal(await connection.getBalance(vaultAuthorityPda(mint)), 0);
});

test("the crank waits, and says until when, for a pool whose first trade is not due", async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const mint = await launch();
  await buy(stranger, mint, BigInt(LAMPORTS_PER_SOL / 20));
  const close = await closingSqrtPrice(mint);
  await squat({ who: stranger, mint, sqrtPrice: close, quoteIn: 5_000_000n, baseIsA: true, activationPoint: now + 7n * 86_400n });
  await fill(mint);
  const done = await crank(mint);
  assert.equal(done.kind, "wait");
  assert.ok("until" in done && done.until && done.until.getTime() > Date.now() + 6 * 86_400_000);
  assert.equal((await fetchCurve(connection, mint))?.state, "graduated");
});

test("the crank leaves a curve that has not filled alone", async () => {
  const mint = await launch();
  const done = await crank(mint);
  assert.equal(done.kind, "not-ready");
});
