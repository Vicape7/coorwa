/**
 * The whole cashback pipeline, once, for real.
 *
 * Everything either side of this is covered in isolation: the tree in `merkle.test.ts`, the
 * arithmetic in `epochs.test.ts`, the wire format in `vault-layout.test.ts`, the program itself in
 * `vault.test.ts`. What none of them touch is the join - a balance in Postgres becoming a root on
 * chain becoming tokens in a wallet - and that join is where a mistake costs money rather than a
 * failed transaction. So this runs the real path end to end:
 *
 *   initialize -> fund -> build a draft from fills -> publish -> claim -> confirm it cannot be
 *   claimed or published twice.
 *
 * Needs a validator with the program loaded and a Postgres, both of which `npm run program:test`
 * starts in Docker. Without DATABASE_URL it skips rather than fails, because the rest of the
 * integration suite has no database to speak of.
 */
import test, { before, after } from "node:test";
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
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { closeDb, db, schema } from "../../src/lib/db";
import {
  buildDraft,
  claimableFor,
  computeEntitlements,
  publishFromChain,
  recordClaim,
  toCook,
} from "../../src/lib/epochs";
import { claimInstructions, fetchVault, fundIx, initializeIx, publishEpochIx } from "../../src/lib/vault";
import { fetchCookPriceUsd } from "../../src/lib/cookiescan";
import { CASHBACK_SPLIT, COOK_DECIMALS, VAULT_MINT } from "../../src/lib/config";

const RPC = process.env.CORWA_TEST_RPC ?? "http://127.0.0.1:8899";
const skip = process.env.DATABASE_URL?.trim()
  ? false
  : "needs DATABASE_URL - npm run program:test starts one";

const connection = new Connection(RPC, "confirmed");
const MINT = new PublicKey(VAULT_MINT);
const UNITS = 10 ** COOK_DECIMALS;

let authority: Keypair;
let alice: Keypair;
let bob: Keypair;
/** Real COOK price, so the amounts below land in a range the vault can actually be funded to. */
let cookUsd: number;

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const { blockhash: bh, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const res = await connection.confirmTransaction(
    { signature, blockhash: bh, lastValidBlockHeight },
    "confirmed",
  );
  if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

async function fundedKey(sol = 5): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return kp;
}

/** The fee a wallet must have generated for its trader share to be worth this many COOK. */
function feeForCook(cook: number): number {
  return (cook * cookUsd) / CASHBACK_SPLIT.trader;
}

let fillSeq = 0;
function fakeFill(wallet: string, feeUsd: number) {
  fillSeq += 1;
  return {
    // The uniqueness key only has to be unique; nothing in this path reads it back off the chain.
    signature: `epochtest${fillSeq}`.padEnd(88, "x"),
    wallet,
    source: "launchpad",
    mint: MINT.toBase58(),
    symbol: "TEST",
    side: "buy",
    valueUsd: feeUsd * 100,
    feeUsd,
    creator: null,
    chain: "cookie",
  };
}

before(async () => {
  if (skip) return;

  cookUsd = (await fetchCookPriceUsd()) ?? 0;
  assert.ok(cookUsd > 0, "the COOK price feed has to answer for this test to size its amounts");

  [authority, alice, bob] = await Promise.all([fundedKey(100), fundedKey(), fundedKey()]);

  // A clean slate, so the draft below contains exactly what this file put there.
  await db!.delete(schema.claims);
  await db!.delete(schema.epochs);
  await db!.delete(schema.fills);
});

after(async () => {
  if (!skip) await closeDb();
});

test("a vault opens and takes a deposit", { skip }, async () => {
  await send([initializeIx(authority.publicKey, MINT)], [authority]);

  // Wrapping native COOK is how the float actually arrives, so the test funds it the same way the
  // operator panel does rather than minting a convenient token.
  const treasury = getAssociatedTokenAddressSync(MINT, authority.publicKey);
  const deposit = BigInt(50 * UNITS);
  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        treasury,
        authority.publicKey,
        MINT,
      ),
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: treasury,
        lamports: deposit,
      }),
      createSyncNativeInstruction(treasury),
      fundIx(authority.publicKey, MINT, treasury, deposit),
    ],
    [authority],
  );

  const snapshot = await fetchVault(connection, MINT);
  assert.ok(snapshot);
  assert.ok(snapshot.state.authority.equals(authority.publicKey));
  assert.equal(snapshot.balance, deposit);
  assert.equal(snapshot.free, deposit);
});

test("a draft is built from fills and is stable when asked twice", { skip }, async () => {
  await db!
    .insert(schema.fills)
    .values([
      fakeFill(alice.publicKey.toBase58(), feeForCook(4)),
      fakeFill(bob.publicKey.toBase58(), feeForCook(1)),
    ]);

  const draft = await buildDraft();
  assert.equal(draft.reused, false);
  assert.equal(draft.epoch.index, "0");
  assert.equal(draft.epoch.claimants, 2);
  assert.equal(draft.shortfallCook, 0, "50 COOK is plenty to back 5");

  // Within rounding of the price conversion, the epoch pays what the fills earned.
  assert.ok(Math.abs(draft.epoch.totalCook - 5) < 0.01, `total was ${draft.epoch.totalCook}`);

  // A second call must not replace what the authority may already be signing against.
  const again = await buildDraft();
  assert.equal(again.reused, true);
  assert.equal(again.epoch.root, draft.epoch.root);
});

test("publishing is only believed once the chain says so", { skip }, async () => {
  const draft = await buildDraft();
  const e = draft.epoch;

  const signature = await send(
    [
      publishEpochIx({
        authority: authority.publicKey,
        mint: MINT,
        index: BigInt(e.index),
        root: hexToBytes(e.root),
        total: BigInt(e.totalRaw),
        claimants: e.claimants,
        deadline: Math.floor(new Date(e.deadline).getTime() / 1000),
      }),
    ],
    [authority],
  );

  const published = await publishFromChain(signature);
  assert.equal(published.status, "published");
  assert.equal(published.signature, signature);
  assert.equal(published.root, e.root);

  // The reserve moved with it, which is what makes the root already funded.
  const snapshot = await fetchVault(connection, MINT);
  assert.equal(snapshot!.state.reserved, BigInt(e.totalRaw));
});

test("a transaction that is not a publish is refused", { skip }, async () => {
  // A real, confirmed, correctly signed transaction that simply does something else. The endpoint
  // reads the instruction rather than believing what it was sent as.
  const signature = await send(
    [
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: alice.publicKey,
        lamports: 1,
      }),
    ],
    [authority],
  );

  await assert.rejects(() => publishFromChain(signature), /does not publish a cashback epoch/);
});

test("a claimant is handed a proof that its own wallet can spend", { skip }, async () => {
  const wallet = alice.publicKey.toBase58();
  const report = await claimableFor(wallet);

  assert.equal(report.deployed, true);
  assert.equal(report.lines.length, 1);

  const [line] = report.lines;
  assert.equal(line.claimable, true);
  assert.equal(line.claimed, false);
  assert.ok(Math.abs(line.amountCook - 4) < 0.01, `line was ${line.amountCook}`);
  assert.ok(Math.abs(report.claimableCook - line.amountCook) < 1e-9);

  const before = await connection.getBalance(alice.publicKey, "confirmed");
  const signature = await send(
    claimInstructions({
      claimant: alice.publicKey,
      mint: MINT,
      index: BigInt(line.epoch),
      amount: BigInt(line.amountRaw),
      proof: line.proof.map(hexToBytes),
    }),
    [alice],
  );

  // The claim pays wrapped COOK into the claimant's own token account, opened in the same
  // transaction and paid for by them.
  const token = getAssociatedTokenAddressSync(MINT, alice.publicKey);
  const paid = await connection.getTokenAccountBalance(token, "confirmed");
  assert.equal(paid.value.amount, line.amountRaw);
  assert.ok(before > 0);

  await recordClaim({ signature, wallet, epoch: BigInt(line.epoch) });

  const after = await claimableFor(wallet);
  assert.equal(after.lines[0].claimed, true);
  assert.equal(after.lines[0].claimable, false);
  assert.equal(after.lines[0].signature, signature);
  assert.equal(after.claimableCook, 0);
});

test("a claimed line is never offered to a second epoch", { skip }, async () => {
  // The rule the whole design rests on. Alice has claimed and Bob has not, but Bob's line is still
  // inside its window, so neither balance is free to be published again.
  const lines = await computeEntitlements(new Date(), cookUsd);
  assert.deepEqual(lines, []);

  await assert.rejects(() => buildDraft({ rebuild: true }), /nothing is owed/);
});

test("new trading after the epoch accrues on top, not instead", { skip }, async () => {
  await db!.insert(schema.fills).values([fakeFill(alice.publicKey.toBase58(), feeForCook(2))]);

  const lines = await computeEntitlements(new Date(), cookUsd);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].wallet, alice.publicKey.toBase58());

  // Exactly the new trading, with the claimed balance netted off rather than paid again.
  assert.ok(Math.abs(toCook(lines[0].amountRaw) - 2) < 0.01, `carried ${toCook(lines[0].amountRaw)}`);
});
