/**
 * The launch program, running.
 *
 * The unit tests prove the curve's arithmetic. They cannot prove the part most likely to be wrong:
 * that a Token-2022 mint built by hand comes out sealed and taxed, that a taxed transfer is priced
 * off what actually arrives, and that Cookiebox's pool program accepts the accounts this program
 * hands it. So this suite runs the whole life of a launch against a validator loaded with the real
 * pool program and the real pool config, both copied off Cookie Chain by `npm run program:fixtures`.
 *
 * Started by `npm run program:test`, and kept out of `npm test` so the unit suite stays offline.
 *
 * One thing is deliberately not covered: fees earned by the graduated pool. Generating them means
 * trading on Cookiebox itself, which is a second program's worth of encoding for very little. What is
 * covered is that `claim_pool_fees` reaches the pool program and comes back saying there is nothing
 * yet, which is the same call path a real claim takes.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeAmount,
  getTransferFeeConfig,
  unpackAccount,
} from "@solana/spl-token";
import {
  DAMM_CONFIG,
  buyIx,
  claimCurveFeesIx,
  claimPoolFeesIx,
  dammPoolPda,
  dammPositionPda,
  fetchCurve,
  fetchLaunchConfig,
  graduateIx,
  graduationParams,
  initializeConfigIx,
  launchIx,
  quoteBuy,
  quoteSell,
  sellIx,
  vaultAuthorityPda,
  baseVault,
  quoteVault,
} from "../../src/lib/launch-program";

const RPC = process.env.COORWA_TEST_RPC ?? "http://127.0.0.1:8899";
const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

/** 800M on the curve and 200M for the pool, the same 80/20 the program defaults to. */
const SALE_BASE = 800_000_000n * UNIT;
const MIGRATION_BASE = 200_000_000n * UNIT;
/** Small enough that one funded wallet can graduate a curve inside a test. */
const GRADUATION_QUOTE = 10n * BigInt(LAMPORTS_PER_SOL);
const VIRTUAL_QUOTE = GRADUATION_QUOTE / 3n;
const VIRTUAL_BASE = (SALE_BASE * 4n) / 3n;
const TAX_BPS = 300;
const CURVE_FEE_BPS = 100;
const CREATOR_LP_SHARE_BPS = 4000;

const connection = new Connection(RPC, "confirmed");
const creator = Keypair.generate();
const trader = Keypair.generate();
const platform = Keypair.generate();
let mint: Keypair;
let traderQuote: PublicKey;
let traderBase: PublicKey;
let platformQuote: PublicKey;

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

/** Wrapped COOK on Cookie Chain is the native mint, which on a test validator is wrapped SOL. */
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
        lamports: sol * LAMPORTS_PER_SOL,
      }),
      createSyncNativeInstruction(account),
    ],
    [owner],
  );
  return account;
}

before(async () => {
  await fund(creator.publicKey, 30);
  await fund(trader.publicKey, 60);
  await fund(platform.publicKey, 1);
  traderQuote = await wrap(trader, 40);
  platformQuote = await wrap(platform, 0);

  if (!(await fetchLaunchConfig(connection))) {
    await send(
      [
        initializeConfigIx(creator.publicKey, NATIVE_MINT, {
          feeRecipient: platform.publicKey,
          withholdAuthority: platform.publicKey,
          curveFeeBps: CURVE_FEE_BPS,
          creatorLpShareBps: CREATOR_LP_SHARE_BPS,
          taxTiers: [100, 200, 300, 0],
          graduationQuote: GRADUATION_QUOTE,
          saleBase: SALE_BASE,
          migrationBase: MIGRATION_BASE,
          virtualQuote: VIRTUAL_QUOTE,
          virtualBase: VIRTUAL_BASE,
          tokenDecimals: DECIMALS,
          paused: false,
          dammConfig: DAMM_CONFIG,
        }),
      ],
      [creator],
    );
  }

  const config = await fetchLaunchConfig(connection);
  assert.ok(config, "the config should exist after initialize");
  assert.equal(config.curveFeeBps, CURVE_FEE_BPS);
  assert.equal(config.dammConfig.toBase58(), DAMM_CONFIG.toBase58());
});

test("a launch mints a token that is sealed and taxed for good", async () => {
  mint = Keypair.generate();
  await send(
    [
      launchIx({
        creator: creator.publicKey,
        mint: mint.publicKey,
        quoteMint: NATIVE_MINT,
        name: "Rehearsal",
        symbol: "REH",
        uri: "https://coorwa.fun/t/rehearsal.json",
        taxBps: TAX_BPS,
      }),
    ],
    [creator, mint],
  );

  const info = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(info.decimals, DECIMALS);
  assert.equal(info.supply, BigInt(SALE_BASE + MIGRATION_BASE));
  assert.equal(info.mintAuthority, null, "the mint authority must be gone");
  assert.equal(info.freezeAuthority, null, "there must be no freeze authority");

  const fee = getTransferFeeConfig(info);
  assert.ok(fee, "the mint must carry a transfer fee");
  assert.equal(fee.newerTransferFee.transferFeeBasisPoints, TAX_BPS);
  assert.equal(fee.olderTransferFee.transferFeeBasisPoints, TAX_BPS, "live from the first trade");
  assert.equal(fee.newerTransferFee.maximumFee, 18446744073709551615n, "a percentage at any size");
  assert.equal(
    fee.transferFeeConfigAuthority.toBase58(),
    PublicKey.default.toBase58(),
    "nobody may ever change the rate",
  );
  assert.equal(fee.withdrawWithheldAuthority.toBase58(), platform.publicKey.toBase58());

  const curve = await fetchCurve(connection, mint.publicKey);
  assert.ok(curve);
  assert.equal(curve.state, "live");
  assert.equal(curve.taxBps, TAX_BPS);
  assert.equal(curve.baseSold, 0n);
  assert.equal(curve.quoteRaised, 0n);
  assert.equal(curve.creator.toBase58(), creator.publicKey.toBase58());

  const vault = await getAccount(
    connection,
    baseVault(mint.publicKey),
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  assert.equal(vault.amount, BigInt(SALE_BASE + MIGRATION_BASE), "the whole supply starts here");
  assert.equal(vault.owner.toBase58(), vaultAuthorityPda(mint.publicKey).toBase58());
});

test("a buy delivers real tokens and the tax is withheld on the buyer", async () => {
  traderBase = getAssociatedTokenAddressSync(
    mint.publicKey,
    trader.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const before = await fetchCurve(connection, mint.publicKey);
  assert.ok(before);
  const spend = BigInt(LAMPORTS_PER_SOL);
  const expected = quoteBuy(before, spend);

  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(
        trader.publicKey,
        traderBase,
        trader.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      buyIx(
        {
          trader: trader.publicKey,
          mint: mint.publicKey,
          quoteMint: NATIVE_MINT,
          traderBase,
          traderQuote,
        },
        spend,
        expected.baseOut,
      ),
    ],
    [trader],
  );

  const account = await connection.getAccountInfo(traderBase);
  assert.ok(account);
  const unpacked = unpackAccount(traderBase, account, TOKEN_2022_PROGRAM_ID);
  assert.equal(unpacked.amount, expected.baseReceived, "the buyer nets the tax off");
  const withheld = getTransferFeeAmount(unpacked);
  assert.equal(
    withheld?.withheldAmount,
    expected.baseOut - expected.baseReceived,
    "and the tax sits withheld in their own account, waiting to be harvested",
  );

  const after = await fetchCurve(connection, mint.publicKey);
  assert.ok(after);
  assert.equal(after.baseSold, expected.baseOut);
  assert.equal(after.quoteRaised, spend - expected.fee);
  assert.equal(after.feesQuote, expected.fee);
});

test("a sell is priced on what reached the vault, not on what was sent", async () => {
  const before = await fetchCurve(connection, mint.publicKey);
  assert.ok(before);
  const held = (
    await getAccount(connection, traderBase, "confirmed", TOKEN_2022_PROGRAM_ID)
  ).amount;
  const sending = held / 2n;
  const expected = quoteSell(before, sending);

  const quoteBefore = (await getAccount(connection, traderQuote)).amount;
  await send(
    [
      sellIx(
        {
          trader: trader.publicKey,
          mint: mint.publicKey,
          quoteMint: NATIVE_MINT,
          traderBase,
          traderQuote,
        },
        sending,
        expected.quoteOut,
      ),
    ],
    [trader],
  );
  const quoteAfter = (await getAccount(connection, traderQuote)).amount;
  assert.equal(quoteAfter - quoteBefore, expected.quoteOut, "the seller gets what was quoted");

  const after = await fetchCurve(connection, mint.publicKey);
  assert.ok(after);
  assert.equal(
    after.baseSold,
    before.baseSold - expected.baseReceived,
    "the curve credits the amount that arrived, which is short by the tax",
  );
  assert.equal(after.quoteRaised, before.quoteRaised - expected.gross);
  assert.equal(after.feesQuote, before.feesQuote + expected.fee);
});

test("the curve closes on its target exactly, and refuses to trade after", async () => {
  const before = await fetchCurve(connection, mint.publicKey);
  assert.ok(before);
  const room = before.graduationQuote - before.quoteRaised;
  // Offer far more than the room on purpose: the program should take only what it needs.
  const offered = room * 3n;
  const expected = quoteBuy(before, offered);
  assert.ok(expected.graduates);
  assert.ok(expected.quoteTaken < offered, "a full curve takes less than it is offered");

  const quoteBefore = (await getAccount(connection, traderQuote)).amount;
  await send(
    [
      buyIx(
        {
          trader: trader.publicKey,
          mint: mint.publicKey,
          quoteMint: NATIVE_MINT,
          traderBase,
          traderQuote,
        },
        offered,
        expected.baseOut,
      ),
    ],
    [trader],
  );
  const quoteAfter = (await getAccount(connection, traderQuote)).amount;
  assert.equal(quoteBefore - quoteAfter, expected.quoteTaken);

  const after = await fetchCurve(connection, mint.publicKey);
  assert.ok(after);
  assert.equal(after.quoteRaised, after.graduationQuote, "the raise lands on the target");
  assert.equal(after.state, "graduated");

  await assert.rejects(
    send(
      [
        buyIx(
          {
            trader: trader.publicKey,
            mint: mint.publicKey,
            quoteMint: NATIVE_MINT,
            traderBase,
            traderQuote,
          },
          1000n,
          0n,
        ),
      ],
      [trader],
    ),
    /custom program error|CurveClosed|0x17/,
  );
});

test("graduation opens a Cookiebox pool and locks it forever", async () => {
  const curve = await fetchCurve(connection, mint.publicKey);
  assert.ok(curve);
  const positionNftMint = Keypair.generate();
  const authority = vaultAuthorityPda(mint.publicKey);

  const baseBefore = (
    await getAccount(connection, baseVault(mint.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)
  ).amount;
  const params = graduationParams(curve, baseBefore);
  assert.ok(params.baseFromVault <= baseBefore, "the seed has to fit in the vault");

  await send(
    [
      // Whoever graduates a curve pays for the pool's accounts. The authority holds no lamports of
      // its own, so they are handed to it here.
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: authority,
        lamports: Math.floor(0.2 * LAMPORTS_PER_SOL),
      }),
      graduateIx({
        mint: mint.publicKey,
        quoteMint: NATIVE_MINT,
        positionNftMint: positionNftMint.publicKey,
        liquidity: params.liquidity,
        sqrtPrice: params.sqrtPrice,
      }),
    ],
    [trader, positionNftMint],
  );

  const after = await fetchCurve(connection, mint.publicKey);
  assert.ok(after);
  assert.equal(after.state, "pooled");
  assert.equal(after.positionNftMint.toBase58(), positionNftMint.publicKey.toBase58());

  const pool = dammPoolPda(mint.publicKey, NATIVE_MINT);
  const poolAccount = await connection.getAccountInfo(pool);
  assert.ok(poolAccount, "the pool must exist");
  assert.equal(poolAccount.owner.toBase58(), "DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY");

  // The position holds all of its liquidity permanently: nothing unlocked, nothing vesting.
  const position = await connection.getAccountInfo(dammPositionPda(positionNftMint.publicKey));
  assert.ok(position);
  const read128 = (at: number) =>
    position.data.readBigUInt64LE(at) | (position.data.readBigUInt64LE(at + 8) << 64n);
  assert.equal(read128(152), 0n, "no unlocked liquidity");
  assert.equal(read128(168), 0n, "no vesting liquidity");
  assert.equal(read128(184), params.liquidity, "all of it locked forever");

  const baseVaultAfter = await getAccount(
    connection,
    baseVault(mint.publicKey),
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  assert.equal(baseVaultAfter.amount, 0n, "everything the pool did not take is burned");
  assert.ok(baseBefore > 0n);

  const quoteVaultAfter = await getAccount(connection, quoteVault(mint.publicKey, NATIVE_MINT));
  assert.ok(quoteVaultAfter.amount >= after.feesQuote, "the curve's own fees are untouched");
  // The reserve can leave a hair behind, because the liquidity is floored and then trimmed to what
  // the vault can afford in base. The program's own guard allows a thousandth and no more.
  const stranded = quoteVaultAfter.amount - after.feesQuote;
  assert.ok(
    stranded * 1000n <= after.quoteRaised,
    `too much of the reserve stayed behind: ${stranded}`,
  );

  // Nothing is burned here, and that is the healthy case: a curve that sells its whole sale supply
  // leaves exactly the pool's share behind, so the pool takes all of it. The burn is what happens to
  // a curve that reaches its target with supply still unsold.
  const supply = (await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID))
    .supply;
  assert.ok(supply <= SALE_BASE + MIGRATION_BASE, "nothing can be minted after a launch");
  assert.equal(baseBefore, params.baseFromVault, "the pool took the whole remaining supply");
});

test("claiming pool fees reaches the pool program, and says so when there are none", async () => {
  const curve = await fetchCurve(connection, mint.publicKey);
  assert.ok(curve);
  const creatorQuote = await wrap(creator, 0);
  const creatorBase = getAssociatedTokenAddressSync(
    mint.publicKey,
    creator.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const platformBase = getAssociatedTokenAddressSync(
    mint.publicKey,
    platform.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  await assert.rejects(
    send(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          creator.publicKey,
          creatorBase,
          creator.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          creator.publicKey,
          platformBase,
          platform.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        claimPoolFeesIx({
          mint: mint.publicKey,
          quoteMint: NATIVE_MINT,
          creator: creator.publicKey,
          positionNftMint: curve.positionNftMint,
          creatorQuote,
          platformQuote,
          creatorBase,
          platformBase,
        }),
      ],
      [creator],
    ),
    /NothingToClaim|0x1775|custom program error/,
    "a pool with no trades yet has nothing to split",
  );
});

test("the curve's own fees go to the platform, whoever asks", async () => {
  const curve = await fetchCurve(connection, mint.publicKey);
  assert.ok(curve);
  assert.ok(curve.feesQuote > 0n, "the curve collected fees on the way up");

  const before = (await getAccount(connection, platformQuote)).amount;
  // Sent by the trader, paid to the platform: the destination is the config's, not the caller's.
  await send([claimCurveFeesIx(mint.publicKey, NATIVE_MINT, platformQuote)], [trader]);
  const after = (await getAccount(connection, platformQuote)).amount;
  assert.equal(after - before, curve.feesQuote);

  const emptied = await fetchCurve(connection, mint.publicKey);
  assert.equal(emptied?.feesQuote, 0n);
});
