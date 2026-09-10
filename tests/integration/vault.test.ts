/**
 * The vault, running.
 *
 * Everything else about this program is checked statically: the layouts match the IDL, the tree
 * matches the verifier. None of that proves the money moves correctly, and this is a program that
 * holds other people's cashback, so the interesting cases here are the ones where it must refuse:
 * claiming twice, claiming someone else's line, publishing an epoch the vault cannot back,
 * publishing from the wrong key.
 *
 * Needs a validator with the program loaded, which `npm run program:test` starts in Docker. It is
 * kept out of `npm test` on purpose so the unit suite stays instant and offline.
 *
 * One path is deliberately not covered: expiry. The program insists a claim window is at least a
 * day long, and the test validator's clock is the wall clock with no way to wind it forward, so
 * `close_epoch` after a deadline cannot be reached here. What is covered is that it refuses to run
 * early, which is the half that protects a claimant.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { buildEpochTree, type Entitlement } from "../../src/lib/merkle";
import {
  claimIx,
  claimInstructions,
  claimStatusPda,
  closeEpochIx,
  decodeClaimStatus,
  decodeEpoch,
  decodeVault,
  epochPda,
  fundIx,
  fundsPda,
  initializeIx,
  publishEpochIx,
  setAuthorityIx,
  unreserved,
  vaultPda,
} from "../../src/lib/vault";

const RPC = process.env.CORWA_TEST_RPC ?? "http://127.0.0.1:8899";
const DECIMALS = 9;
const DAY = 24 * 60 * 60;

const idl = JSON.parse(
  readFileSync(new URL("../../programs/corwa-vault/idl.json", import.meta.url), "utf8"),
) as { errors: { code: number; name: string }[] };

const errorCode = (name: string) => {
  const found = idl.errors.find((e) => e.name === name);
  if (!found) throw new Error(`the program has no error called ${name}`);
  return found.code;
};

const connection = new Connection(RPC, "confirmed");

async function fundedKey(sol = 5): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  return kp;
}

async function send(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions);
  const bh = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, ...bh }, "confirmed");
  return signature;
}

/** Run something that should fail, and report which program error it actually hit. */
async function failsWith(
  name: string,
  instructions: TransactionInstruction[],
  signers: Keypair[],
): Promise<void> {
  const want = errorCode(name);
  try {
    await send(instructions, signers);
  } catch (e) {
    const text = `${e instanceof Error ? e.message : String(e)} ${JSON.stringify(
      (e as { logs?: string[] }).logs ?? [],
    )}`;
    const hit = text.match(/custom program error: 0x([0-9a-f]+)/i);
    const code = hit ? parseInt(hit[1], 16) : null;
    assert.equal(
      code,
      want,
      `expected ${name} (${want}), got ${code ?? "no custom error"}\n${text.slice(0, 900)}`,
    );
    return;
  }
  assert.fail(`expected ${name}, but the transaction succeeded`);
}

const readVault = async (address: PublicKey) =>
  decodeVault(address, (await connection.getAccountInfo(address))!.data);
const readEpoch = async (address: PublicKey) =>
  decodeEpoch(address, (await connection.getAccountInfo(address))!.data);
const balanceOf = async (account: PublicKey) => (await getAccount(connection, account)).amount;

let authority: Keypair;
let mint: PublicKey;
let vault: PublicKey;
let funds: PublicKey;
let treasury: PublicKey;
/** Wallets that will appear in the epoch, plus one that never does. */
let alice: Keypair;
let bob: Keypair;
let carol: Keypair;
let stranger: Keypair;
let entitlements: Entitlement[];

before(async () => {
  authority = await fundedKey(20);
  [alice, bob, carol, stranger] = await Promise.all([
    fundedKey(),
    fundedKey(),
    fundedKey(),
    fundedKey(),
  ]);

  mint = await createMint(connection, authority, authority.publicKey, null, DECIMALS);
  vault = vaultPda(mint);
  funds = fundsPda(vault);

  treasury = await createAssociatedTokenAccountIdempotent(
    connection,
    authority,
    mint,
    authority.publicKey,
  );
  await mintTo(connection, authority, mint, treasury, authority, 1_000_000_000_000n);

  entitlements = [
    { wallet: alice.publicKey.toBase58(), amount: 30_000_000n },
    { wallet: bob.publicKey.toBase58(), amount: 12_500_000n },
    { wallet: carol.publicKey.toBase58(), amount: 7_500_000n },
  ];
});

after(() => {
  // The validator is torn down by the runner, not from here.
});

test("initialize opens a vault whose funds account it owns", async () => {
  await send([initializeIx(authority.publicKey, mint)], [authority]);

  const state = await readVault(vault);
  assert.ok(state.authority.equals(authority.publicKey));
  assert.ok(state.mint.equals(mint));
  assert.ok(state.tokenAccount.equals(funds));
  assert.equal(state.epochCount, 0n);
  assert.equal(state.totalFunded, 0n);
  assert.equal(state.totalClaimed, 0n);
  assert.equal(state.reserved, 0n);

  // The token account is held by the vault PDA, which no key can sign for.
  const account = await getAccount(connection, funds);
  assert.ok(account.owner.equals(vault));
  assert.ok(account.mint.equals(mint));
  assert.equal(account.amount, 0n);
});

test("a mint gets one vault and only one", async () => {
  // The address is derived from the mint, so a second initialize collides with the account that is
  // already there rather than quietly opening a rival vault.
  await assert.rejects(() => send([initializeIx(authority.publicKey, mint)], [authority]));
});

test("an epoch cannot promise money the vault does not hold", async () => {
  const tree = buildEpochTree(entitlements, 0n);
  await failsWith(
    "InsufficientReserve",
    [
      publishEpochIx({
        authority: authority.publicKey,
        mint,
        index: 0n,
        root: tree.root,
        total: tree.total,
        claimants: entitlements.length,
        deadline: Math.floor(Date.now() / 1000) + 30 * DAY,
      }),
    ],
    [authority],
  );
});

test("fund moves tokens in and anyone may do it", async () => {
  const gift = 100_000_000n;
  await send([fundIx(authority.publicKey, mint, treasury, gift)], [authority]);

  assert.equal(await balanceOf(funds), gift);
  const state = await readVault(vault);
  assert.equal(state.totalFunded, gift);
  assert.equal(state.reserved, 0n);
  assert.equal(unreserved(state, await balanceOf(funds)), gift);

  await failsWith("AmountZero", [fundIx(authority.publicKey, mint, treasury, 0n)], [authority]);
});

test("only the authority publishes, and only in order", async () => {
  const tree = buildEpochTree(entitlements, 0n);
  const deadline = Math.floor(Date.now() / 1000) + 30 * DAY;
  const args = {
    mint,
    root: tree.root,
    total: tree.total,
    claimants: entitlements.length,
    deadline,
  };

  await failsWith(
    "Unauthorized",
    [publishEpochIx({ ...args, authority: stranger.publicKey, index: 0n })],
    [stranger],
  );
  await failsWith(
    "WrongEpochIndex",
    [publishEpochIx({ ...args, authority: authority.publicKey, index: 1n })],
    [authority],
  );
  await failsWith(
    "ClaimWindowTooShort",
    [
      publishEpochIx({
        ...args,
        authority: authority.publicKey,
        index: 0n,
        deadline: Math.floor(Date.now() / 1000) + 60,
      }),
    ],
    [authority],
  );
});

test("publishing reserves the total against the vault's balance", async () => {
  const tree = buildEpochTree(entitlements, 0n);
  const deadline = Math.floor(Date.now() / 1000) + 30 * DAY;

  await send(
    [
      publishEpochIx({
        authority: authority.publicKey,
        mint,
        index: 0n,
        root: tree.root,
        total: tree.total,
        claimants: entitlements.length,
        deadline,
      }),
    ],
    [authority],
  );

  const state = await readVault(vault);
  assert.equal(state.epochCount, 1n);
  assert.equal(state.reserved, tree.total);

  const epoch = await readEpoch(epochPda(vault, 0n));
  assert.deepEqual(Array.from(epoch.root), Array.from(tree.root));
  assert.equal(epoch.total, tree.total);
  assert.equal(epoch.claimed, 0n);
  assert.equal(epoch.claimants, entitlements.length);
  assert.equal(epoch.claimedCount, 0);
  assert.equal(epoch.closed, false);
  assert.equal(Math.floor(epoch.deadline.getTime() / 1000), deadline);
});

test("a second epoch can only use what the first one left", async () => {
  const state = await readVault(vault);
  const free = unreserved(state, await balanceOf(funds));
  const solo = buildEpochTree([{ wallet: stranger.publicKey.toBase58(), amount: free + 1n }], 1n);

  await failsWith(
    "InsufficientReserve",
    [
      publishEpochIx({
        authority: authority.publicKey,
        mint,
        index: 1n,
        root: solo.root,
        total: solo.total,
        claimants: 1,
        deadline: Math.floor(Date.now() / 1000) + 30 * DAY,
      }),
    ],
    [authority],
  );
});

test("a claimant gets exactly what the root says, once", async () => {
  const tree = buildEpochTree(entitlements, 0n);
  const amount = tree.amountFor(alice.publicKey.toBase58())!;
  const ata = getAssociatedTokenAddressSync(mint, alice.publicKey);

  const before = await readVault(vault);
  await send(
    claimInstructions({
      claimant: alice.publicKey,
      mint,
      index: 0n,
      amount,
      proof: tree.proofFor(alice.publicKey.toBase58()),
    }),
    [alice],
  );

  assert.equal(await balanceOf(ata), amount);

  const after = await readVault(vault);
  assert.equal(after.reserved, before.reserved - amount);
  assert.equal(after.totalClaimed, amount);

  const epoch = await readEpoch(epochPda(vault, 0n));
  assert.equal(epoch.claimed, amount);
  assert.equal(epoch.claimedCount, 1);

  const record = decodeClaimStatus(
    (await connection.getAccountInfo(claimStatusPda(epochPda(vault, 0n), alice.publicKey)))!.data,
  );
  assert.ok(record.claimant.equals(alice.publicKey));
  assert.equal(record.amount, amount);

  // The claim record already exists, so the second attempt cannot even be created.
  await assert.rejects(() =>
    send(
      claimInstructions({
        claimant: alice.publicKey,
        mint,
        index: 0n,
        amount,
        proof: tree.proofFor(alice.publicKey.toBase58()),
      }),
      [alice],
    ),
  );
});

test("a proof is worthless for any other wallet or amount", async () => {
  const tree = buildEpochTree(entitlements, 0n);
  const bobKey = bob.publicKey.toBase58();
  const bobAmount = tree.amountFor(bobKey)!;
  const proof = tree.proofFor(bobKey);

  const claimAs = (claimant: Keypair, amount: bigint, useProof = proof) => [
    ...claimInstructions({ claimant: claimant.publicKey, mint, index: 0n, amount, proof: useProof }),
  ];

  // Bob's own proof, but inflated.
  await failsWith("InvalidProof", claimAs(bob, bobAmount + 1n), [bob]);
  // Bob's proof and Bob's amount, presented by someone else. The leaf commits to the claimant.
  await failsWith("InvalidProof", claimAs(carol, bobAmount), [carol]);
  // A wallet that is not in the tree at all, borrowing a real proof.
  await failsWith("InvalidProof", claimAs(stranger, bobAmount), [stranger]);
  // A proof for the right wallet with a step removed.
  await failsWith("InvalidProof", claimAs(bob, bobAmount, proof.slice(1)), [bob]);

  // And the honest version still works afterwards, so none of the above consumed anything.
  await send(claimAs(bob, bobAmount), [bob]);
  assert.equal(await balanceOf(getAssociatedTokenAddressSync(mint, bob.publicKey)), bobAmount);
});

test("tokens cannot be redirected to an account the claimant does not own", async () => {
  const tree = buildEpochTree(entitlements, 0n);
  const carolKey = carol.publicKey.toBase58();

  await failsWith(
    "WrongOwner",
    [
      claimIx({
        claimant: carol.publicKey,
        mint,
        index: 0n,
        amount: tree.amountFor(carolKey)!,
        proof: tree.proofFor(carolKey),
        // Someone else's token account, which is the whole point of the constraint.
        claimantToken: treasury,
      }),
    ],
    [carol],
  );
});

test("an epoch cannot be retired while its window is open", async () => {
  await failsWith("ClaimWindowOpen", [closeEpochIx(mint, 0n)], [authority]);
});

test("authority is the right to publish, and it can be handed on", async () => {
  const next = await fundedKey();

  await failsWith(
    "Unauthorized",
    [setAuthorityIx(stranger.publicKey, mint, stranger.publicKey)],
    [stranger],
  );

  await send([setAuthorityIx(authority.publicKey, mint, next.publicKey)], [authority]);
  assert.ok((await readVault(vault)).authority.equals(next.publicKey));

  // The old key is now just a wallet.
  const solo = buildEpochTree([{ wallet: stranger.publicKey.toBase58(), amount: 1_000n }], 1n);
  const args = {
    mint,
    index: 1n,
    root: solo.root,
    total: solo.total,
    claimants: 1,
    deadline: Math.floor(Date.now() / 1000) + 30 * DAY,
  };
  await failsWith(
    "Unauthorized",
    [publishEpochIx({ ...args, authority: authority.publicKey })],
    [authority],
  );

  await send([publishEpochIx({ ...args, authority: next.publicKey })], [next]);
  assert.equal((await readVault(vault)).epochCount, 2n);

  // Hand it back so the vault ends the run the way it started.
  await send([setAuthorityIx(next.publicKey, mint, authority.publicKey)], [next]);
});

test("a root built for the wrong epoch is unclaimable, not misclaimable", async () => {
  // The epoch index is inside every leaf, so a root and the epoch it is published under have to
  // agree. Here they deliberately do not: the tree says epoch 0, the epoch says 2. The program
  // recomputes the leaf from the epoch it was actually given, so nothing verifies against it.
  const entry = [{ wallet: stranger.publicKey.toBase58(), amount: 5_000n }];
  const mismatched = buildEpochTree(entry, 0n);
  assert.ok(!mismatched.root.equals(buildEpochTree(entry, 2n).root));

  await send(
    [
      publishEpochIx({
        authority: authority.publicKey,
        mint,
        index: 2n,
        root: mismatched.root,
        total: mismatched.total,
        claimants: 1,
        deadline: Math.floor(Date.now() / 1000) + 30 * DAY,
      }),
    ],
    [authority],
  );

  await failsWith(
    "InvalidProof",
    claimInstructions({
      claimant: stranger.publicKey,
      mint,
      index: 2n,
      amount: 5_000n,
      proof: mismatched.proofFor(stranger.publicKey.toBase58()),
    }),
    [stranger],
  );
});

test("the vault's balance never falls below what it has promised", async () => {
  const state = await readVault(vault);
  const held = await balanceOf(funds);

  assert.ok(held >= state.reserved, `holds ${held}, promised ${state.reserved}`);
  assert.equal(state.totalFunded - state.totalClaimed, held);
});
