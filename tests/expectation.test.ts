/**
 * The launchpad check, against real MomoSwap builds.
 *
 * Every file in `fixtures/momoswap` is a response captured from the live builder, next to the
 * request that produced it, so the honest cases run on the builder's own bytes rather than on
 * something rebuilt to look like them. Each refusal starts from one of those and changes one thing:
 * either what the user asked for, or the transaction itself with a declaration rewritten to match.
 * The second is the builder that lies consistently, which is the case the declaration alone would
 * wave through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  BuildMismatchError,
  LAUNCHPAD_IX,
  verifyLaunchpadBuild,
  type Expectation,
  type LaunchpadBuild,
  type LaunchpadIntent,
} from "../src/lib/expectation";

interface Captured<R> {
  request: R;
  response: LaunchpadBuild;
}
interface BuyRequest {
  buyer: string;
  pool: string;
  paymentAmount: string;
  referrer?: string;
}
interface CreateRequest {
  creator: string;
  params: { name: string; symbol: string; duration_secs: number };
  devBuyCook?: string;
}

const load = <R>(name: string): Captured<R> =>
  JSON.parse(readFileSync(new URL(`./fixtures/momoswap/${name}.json`, import.meta.url), "utf8"));

const buyReferred = load<BuyRequest>("buy-referred");
const buyPlain = load<BuyRequest>("buy-unreferred");
const sell = load<{ seller: string; pool: string; tokenShares: string }>("sell");
const claim = load<{ creator: string; pool: string }>("claim-creator-fees");
const graduated = load<{ claimant: string; pool: string }>("claim-graduated-tokens");
const create = load<CreateRequest>("create");
const createDevBuy = load<CreateRequest>("create-dev-buy");

const buyIntent = (c: Captured<BuyRequest>): LaunchpadIntent => ({
  action: "buy",
  wallet: c.request.buyer,
  pool: c.request.pool,
  paymentRaw: c.request.paymentAmount,
  referrer: c.request.referrer ?? null,
});
const sellIntent: LaunchpadIntent = {
  action: "sell",
  wallet: sell.request.seller,
  pool: sell.request.pool,
  sharesRaw: sell.request.tokenShares,
};
const claimIntent: LaunchpadIntent = {
  action: "claim-creator-fees",
  wallet: claim.request.creator,
  pool: claim.request.pool,
};
/** COTE, the token the captured graduated claim delivers. */
const COTE = "BDEFBNgzV5MzCnF4ccWNYbjy5g8wh5Y76T4xkWn1momo";
const graduatedIntent: LaunchpadIntent = {
  action: "claim-graduated-tokens",
  wallet: graduated.request.claimant,
  pool: graduated.request.pool,
  mint: COTE,
};
const createIntent = (c: Captured<CreateRequest>): LaunchpadIntent => ({
  action: "create",
  wallet: c.request.creator,
  name: c.request.params.name,
  symbol: c.request.params.symbol,
  durationSecs: c.request.params.duration_secs,
  expiryMode: "fair",
  devBuyRaw: c.request.devBuyCook ?? null,
});

const wallet = new PublicKey(buyPlain.request.buyer);
const stranger = Keypair.generate().publicKey;

/** What an honest builder would declare for these bytes, computed the way MomoSwap's matches. */
function declare(base64: string): Expectation {
  const message = TransactionMessage.decompile(
    VersionedTransaction.deserialize(Buffer.from(base64, "base64")).message,
  );
  return {
    feePayer: message.payerKey.toBase58(),
    instructions: message.instructions.map((ix) => {
      const transfer =
        ix.programId.equals(SystemProgram.programId) &&
        ix.data.length === 12 &&
        ix.data.readUInt32LE(0) === 2
          ? { to: ix.keys[1].pubkey.toBase58(), lamports: ix.data.readBigUInt64LE(4).toString() }
          : undefined;
      return {
        programId: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          signer: k.isSigner,
          writable: k.isWritable,
        })),
        dataHash: createHash("sha256").update(ix.data).digest("hex"),
        ...(transfer ? { transfer } : {}),
      };
    }),
  };
}

/** Rebuild a captured single-signer transaction with its instructions changed, declared to match. */
function tamper(
  build: LaunchpadBuild,
  change: (ixs: TransactionInstruction[]) => TransactionInstruction[],
): LaunchpadBuild {
  const message = TransactionMessage.decompile(
    VersionedTransaction.deserialize(Buffer.from(build.transactionBase64, "base64")).message,
  );
  const rebuilt = new Transaction({
    feePayer: message.payerKey,
    recentBlockhash: message.recentBlockhash,
  }).add(...change([...message.instructions]));
  const transactionBase64 = rebuilt
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  return { ...build, transactionBase64, expectation: declare(transactionBase64) };
}

const tag = (ix: TransactionInstruction) => ix.data.subarray(0, 8).toString("hex");

async function refused(build: LaunchpadBuild, intent: LaunchpadIntent, pattern: RegExp) {
  await assert.rejects(verifyLaunchpadBuild(build, intent), (e: unknown) => {
    assert.ok(e instanceof BuildMismatchError, `expected a BuildMismatchError, got ${String(e)}`);
    assert.match(e.message, pattern);
    return true;
  });
}

// --- What passes ---------------------------------------------------------------------------------

test("every captured build passes against the request that produced it", async () => {
  await verifyLaunchpadBuild(buyReferred.response, buyIntent(buyReferred));
  await verifyLaunchpadBuild(buyPlain.response, buyIntent(buyPlain));
  await verifyLaunchpadBuild(sell.response, sellIntent);
  await verifyLaunchpadBuild(claim.response, claimIntent);
  await verifyLaunchpadBuild(graduated.response, graduatedIntent);
  await verifyLaunchpadBuild(create.response, createIntent(create));
  await verifyLaunchpadBuild(createDevBuy.response, createIntent(createDevBuy));
});

test("the tampering helper changes nothing when asked to change nothing", async () => {
  const same = tamper(buyPlain.response, (ixs) => ixs);
  assert.deepEqual(same.expectation, buyPlain.response.expectation);
  await verifyLaunchpadBuild(same, buyIntent(buyPlain));
});

test("a modest priority fee is not a reason to refuse", async () => {
  const priced = tamper(buyPlain.response, (ixs) => [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    ...ixs,
  ]);
  await verifyLaunchpadBuild(priced, buyIntent(buyPlain));
});

test("the named discriminators are the ones Anchor derives from their names", () => {
  for (const [name, hex] of Object.entries(LAUNCHPAD_IX)) {
    if (name === "pre_trade") continue;
    const derived = createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
    assert.equal(derived.toString("hex"), hex, name);
  }
});

// --- The declaration -----------------------------------------------------------------------------

test("a build with no declaration is refused", async () => {
  await refused(
    { ...buyPlain.response, expectation: undefined },
    buyIntent(buyPlain),
    /did not declare/,
  );
});

test("bytes that differ from the declaration are refused", async () => {
  const changed = tamper(buyPlain.response, (ixs) => [
    ...ixs,
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: stranger, lamports: 1 }),
  ]);
  await refused(
    { ...changed, expectation: buyPlain.response.expectation },
    buyIntent(buyPlain),
    /launchpad declared/,
  );

  const expectation = structuredClone(buyPlain.response.expectation!);
  expectation.instructions[2].transfer!.lamports = "1";
  await refused({ ...buyPlain.response, expectation }, buyIntent(buyPlain), /different amount/);
});

// --- What the user asked for ---------------------------------------------------------------------

test("a buy for a different amount is refused", async () => {
  await refused(
    buyPlain.response,
    { ...buyIntent(buyPlain), paymentRaw: "20000000" } as LaunchpadIntent,
    /spends 0\.025 COOK and you asked to spend 0\.02 COOK/,
  );
});

test("a buy naming a referrer other than the one Coorwa chose is refused", async () => {
  await refused(
    buyReferred.response,
    { ...buyIntent(buyReferred), referrer: stranger.toBase58() } as LaunchpadIntent,
    /at your expense|as referrer/,
  );
  await refused(
    buyPlain.response,
    { ...buyIntent(buyPlain), referrer: stranger.toBase58() } as LaunchpadIntent,
    /names no one as referrer/,
  );
});

test("a fee payer other than the wallet is refused", async () => {
  await refused(
    buyPlain.response,
    { ...buyIntent(buyPlain), wallet: stranger.toBase58() } as LaunchpadIntent,
    /pay its fee/,
  );
});

test("COOK sent anywhere but the wallet's own wrapped account is refused", async () => {
  const leaking = tamper(buyPlain.response, (ixs) => [
    ...ixs,
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: stranger, lamports: 1_000_000_000 }),
  ]);
  await refused(leaking, buyIntent(buyPlain), /not your own wrapped COOK account/);
});

test("wrapping more COOK than the buy spends is refused", async () => {
  const own = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
  const greedy = tamper(buyPlain.response, (ixs) =>
    ixs.map((ix) =>
      ix.programId.equals(SystemProgram.programId)
        ? SystemProgram.transfer({ fromPubkey: wallet, toPubkey: own, lamports: 50_000_000 })
        : ix,
    ),
  );
  await refused(greedy, buyIntent(buyPlain), /wraps 0\.05 COOK/);
});

test("a delegate approval on the wallet's COOK is refused", async () => {
  const own = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
  const approving = tamper(buyPlain.response, (ixs) => [
    ...ixs,
    createApproveInstruction(own, stranger, wallet, 1_000_000_000n),
  ]);
  await refused(approving, buyIntent(buyPlain), /token program/);
});

test("opening a token account for someone else at the wallet's expense is refused", async () => {
  const opening = tamper(buyPlain.response, (ixs) => [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet,
      getAssociatedTokenAddressSync(NATIVE_MINT, stranger, true),
      stranger,
      NATIVE_MINT,
    ),
    ...ixs,
  ]);
  await refused(opening, buyIntent(buyPlain), /at your expense/);
});

test("a program a launchpad transaction has no reason to call is refused", async () => {
  const foreign = tamper(buyPlain.response, (ixs) => [
    ...ixs,
    new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.alloc(0) }),
  ]);
  await refused(foreign, buyIntent(buyPlain), /no reason to call/);
});

test("a priority fee that could burn the wallet's COOK is refused", async () => {
  const burning = tamper(buyPlain.response, (ixs) => [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000_000 }),
    ...ixs,
  ]);
  await refused(burning, buyIntent(buyPlain), /priority fees/);
});

test("a second buy, or a launchpad instruction the action does not need, is refused", async () => {
  const twice = tamper(buyPlain.response, (ixs) => [
    ...ixs,
    ...ixs.filter((ix) => tag(ix) === LAUNCHPAD_IX.buy),
  ]);
  await refused(twice, buyIntent(buyPlain), /2 buy instructions/);

  const extra = tamper(buyPlain.response, (ixs) => [
    ...ixs,
    new TransactionInstruction({
      programId: new PublicKey("momoL7wu4TrXjnXMLCLzGsbx8Pm7XGgoYo7FVqDoqcw"),
      keys: [{ pubkey: wallet, isSigner: true, isWritable: true }],
      data: Buffer.from("0102030405060708", "hex"),
    }),
  ]);
  await refused(extra, buyIntent(buyPlain), /does not need/);
});

test("a sell of a different size is refused", async () => {
  await refused(
    sell.response,
    { ...sellIntent, sharesRaw: "999" } as LaunchpadIntent,
    /sells 1000000 raw shares and you asked to sell 999/,
  );
});

test("a claim on a different curve is refused", async () => {
  await refused(
    claim.response,
    { ...claimIntent, pool: stranger.toBase58() } as LaunchpadIntent,
    /curve other than/,
  );
});

test("a graduated claim on a different curve, or for a different token, is refused", async () => {
  await refused(
    graduated.response,
    { ...graduatedIntent, pool: stranger.toBase58() } as LaunchpadIntent,
    /curve other than/,
  );
  await refused(
    graduated.response,
    { ...graduatedIntent, mint: stranger.toBase58() } as LaunchpadIntent,
    /associated token program|token other than/,
  );
});

test("a creator-fee claim may not open a token account for anything but COOK", async () => {
  await refused(
    graduated.response,
    { action: "claim-creator-fees", wallet: graduatedIntent.wallet, pool: graduatedIntent.pool },
    /associated token program/,
  );
});

// --- Launches ------------------------------------------------------------------------------------

test("a launch under a different name or symbol is refused", async () => {
  await refused(
    create.response,
    { ...createIntent(create), symbol: "OTHER" } as LaunchpadIntent,
    /launches "Probe" \(PROBE\) and you asked for "Probe" \(OTHER\)/,
  );
  await refused(
    create.response,
    { ...createIntent(create), name: "Other" } as LaunchpadIntent,
    /you asked for "Other"/,
  );
});

test("a launch open for a different length of time is refused", async () => {
  await refused(
    create.response,
    { ...createIntent(create), durationSecs: 3600 } as LaunchpadIntent,
    /length of time/,
  );
});

test("a launch creating a token other than the one reported is refused", async () => {
  await refused(
    { ...create.response, mint: stranger.toBase58() },
    createIntent(create),
    /different token or curve/,
  );
  await refused(
    { ...create.response, mint: undefined },
    createIntent(create),
    /did not say which token/,
  );
});

test("a dev buy that differs from the one asked for is refused", async () => {
  await refused(
    create.response,
    { ...createIntent(create), devBuyRaw: "5000000" } as LaunchpadIntent,
    /0 dev buy instructions/,
  );
  await refused(
    createDevBuy.response,
    { ...createIntent(createDevBuy), devBuyRaw: null } as LaunchpadIntent,
    /no dev buy/,
  );
  await refused(
    createDevBuy.response,
    { ...createIntent(createDevBuy), devBuyRaw: "1000000" } as LaunchpadIntent,
    /dev buy spends 0\.005 COOK and you asked to spend 0\.001 COOK/,
  );
});

test("a launch still missing one of the launchpad's own signatures is refused", async () => {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(create.response.transactionBase64, "base64"),
  );
  tx.signatures[1] = new Uint8Array(64);
  await refused(
    { ...create.response, transactionBase64: Buffer.from(tx.serialize()).toString("base64") },
    createIntent(create),
    /also needs a signature/,
  );
});
