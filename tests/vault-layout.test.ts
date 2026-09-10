/**
 * The client talks to the vault by wire format rather than through a generated IDL, which is only
 * safe while the bytes it writes are the bytes the program expects. So this file recomputes every
 * discriminator from the instruction name the way Anchor does, pins each account list and each
 * argument layout, and decodes a hand-built account back out again.
 *
 * A mismatch here is not a failing unit test, it is a transaction that either reverts or, worse,
 * dispatches to the wrong instruction. That is why the constants are asserted rather than imported
 * from a build artefact nobody reads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ACCOUNT_DISCRIMINATOR,
  VAULT_PROGRAM_ID,
  claimIx,
  claimInstructions,
  claimStatusPda,
  closeEpochIx,
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
} from "../src/lib/vault";

const anchorTag = (s: string) => Array.from(createHash("sha256").update(s).digest().subarray(0, 8));

const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const alice = Keypair.generate().publicKey;
const bob = Keypair.generate().publicKey;

test("instruction discriminators are the ones Anchor derives", () => {
  const expected: Record<string, string> = {
    initialize: "global:initialize",
    fund: "global:fund",
    publish_epoch: "global:publish_epoch",
    claim: "global:claim",
    close_epoch: "global:close_epoch",
    set_authority: "global:set_authority",
  };

  const built: Record<string, number[]> = {
    initialize: Array.from(initializeIx(alice, MINT).data.subarray(0, 8)),
    fund: Array.from(fundIx(alice, MINT, bob, 1n).data.subarray(0, 8)),
    publish_epoch: Array.from(
      publishEpochIx({
        authority: alice,
        mint: MINT,
        index: 0n,
        root: new Uint8Array(32).fill(7),
        total: 1n,
        claimants: 1,
        deadline: 1,
      }).data.subarray(0, 8),
    ),
    claim: Array.from(
      claimIx({
        claimant: alice,
        mint: MINT,
        index: 0n,
        amount: 1n,
        proof: [],
        claimantToken: bob,
      }).data.subarray(0, 8),
    ),
    close_epoch: Array.from(closeEpochIx(MINT, 0n).data.subarray(0, 8)),
    set_authority: Array.from(setAuthorityIx(alice, MINT, bob).data.subarray(0, 8)),
  };

  for (const [name, preimage] of Object.entries(expected)) {
    assert.deepEqual(built[name], anchorTag(preimage), `${name} dispatches to the wrong handler`);
  }
});

test("account discriminators are the ones Anchor derives", () => {
  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.vault), anchorTag("account:Vault"));
  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.epoch), anchorTag("account:Epoch"));
  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.claimStatus), anchorTag("account:ClaimStatus"));
});

test("addresses follow the seeds the program derives", () => {
  const seed = (s: string) => Buffer.from(s, "utf8");
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };

  const vault = PublicKey.findProgramAddressSync(
    [seed("vault"), MINT.toBuffer()],
    VAULT_PROGRAM_ID,
  )[0];
  assert.ok(vaultPda(MINT).equals(vault));

  assert.ok(
    fundsPda(vault).equals(
      PublicKey.findProgramAddressSync([seed("funds"), vault.toBuffer()], VAULT_PROGRAM_ID)[0],
    ),
  );

  const epoch = epochPda(vault, 3n);
  assert.ok(
    epoch.equals(
      PublicKey.findProgramAddressSync(
        [seed("epoch"), vault.toBuffer(), u64(3n)],
        VAULT_PROGRAM_ID,
      )[0],
    ),
  );

  assert.ok(
    claimStatusPda(epoch, alice).equals(
      PublicKey.findProgramAddressSync(
        [seed("claim"), epoch.toBuffer(), alice.toBuffer()],
        VAULT_PROGRAM_ID,
      )[0],
    ),
  );

  // The index is part of the seed, so two epochs never share an address.
  assert.ok(!epochPda(vault, 3n).equals(epochPda(vault, 4n)));
});

test("claim passes the accounts the program expects, in order", () => {
  const vault = vaultPda(MINT);
  const epoch = epochPda(vault, 2n);
  const ix = claimIx({
    claimant: alice,
    mint: MINT,
    index: 2n,
    amount: 42n,
    proof: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
    claimantToken: bob,
  });

  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    [
      alice,
      vault,
      epoch,
      claimStatusPda(epoch, alice),
      MINT,
      fundsPda(vault),
      bob,
      TOKEN_PROGRAM_ID,
      SystemProgram.programId,
    ].map((k) => k.toBase58()),
  );

  // Only the claimant signs, and only the accounts the instruction writes are writable.
  assert.deepEqual(
    ix.keys.map((k) => k.isSigner),
    [true, false, false, false, false, false, false, false, false],
  );
  assert.deepEqual(
    ix.keys.map((k) => k.isWritable),
    [true, true, true, true, false, true, true, false, false],
  );
});

test("a claim creates the claimant's token account first, idempotently", () => {
  const [create, claim] = claimInstructions({
    claimant: alice,
    mint: MINT,
    index: 0n,
    amount: 5n,
    proof: [],
  });
  const ata = getAssociatedTokenAddressSync(MINT, alice);

  // Idempotent create is instruction 1 of the associated token program, so it is a no-op for a
  // wallet that already holds COOK rather than a failure.
  assert.equal(create.data[0], 1);
  assert.ok(create.keys[1].pubkey.equals(ata));
  assert.ok(claim.keys[6].pubkey.equals(ata));
  assert.ok(claim.keys[0].pubkey.equals(alice) && claim.keys[0].isSigner);
});

test("claim arguments are borsh: u64 amount then a length-prefixed vector of 32-byte nodes", () => {
  const proof = [new Uint8Array(32).fill(0xaa), new Uint8Array(32).fill(0xbb)];
  const data = claimIx({
    claimant: alice,
    mint: MINT,
    index: 0n,
    amount: 1_234_567_890n,
    proof,
    claimantToken: bob,
  }).data;

  assert.equal(data.length, 8 + 8 + 4 + 64);
  assert.equal(data.readBigUInt64LE(8), 1_234_567_890n);
  assert.equal(data.readUInt32LE(16), 2);
  assert.deepEqual(Array.from(data.subarray(20, 52)), Array.from(proof[0]));
  assert.deepEqual(Array.from(data.subarray(52, 84)), Array.from(proof[1]));

  const empty = claimIx({
    claimant: alice,
    mint: MINT,
    index: 0n,
    amount: 1n,
    proof: [],
    claimantToken: bob,
  }).data;
  assert.equal(empty.length, 20);
  assert.equal(empty.readUInt32LE(16), 0);
});

test("publish_epoch arguments are laid out index, root, total, claimants, deadline", () => {
  const root = new Uint8Array(32).map((_, i) => i);
  const data = publishEpochIx({
    authority: alice,
    mint: MINT,
    index: 5n,
    root,
    total: 9_000n,
    claimants: 12,
    deadline: 1_800_000_000,
  }).data;

  assert.equal(data.length, 8 + 8 + 32 + 8 + 4 + 8);
  assert.equal(data.readBigUInt64LE(8), 5n);
  assert.deepEqual(Array.from(data.subarray(16, 48)), Array.from(root));
  assert.equal(data.readBigUInt64LE(48), 9_000n);
  assert.equal(data.readUInt32LE(56), 12);
  assert.equal(data.readBigInt64LE(60), 1_800_000_000n);
});

test("initialize and close_epoch carry nothing but their tag", () => {
  assert.equal(initializeIx(alice, MINT).data.length, 8);
  assert.equal(closeEpochIx(MINT, 1n).data.length, 8);

  // close_epoch is permissionless, so it must not ask anyone to sign.
  assert.deepEqual(
    closeEpochIx(MINT, 1n).keys.map((k) => k.isSigner),
    [false, false],
  );
});

test("initialize passes the mint before the vault it derives from", () => {
  const vault = vaultPda(MINT);
  assert.deepEqual(
    initializeIx(alice, MINT).keys.map((k) => k.pubkey.toBase58()),
    [alice, MINT, vault, fundsPda(vault), TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY].map(
      (k) => k.toBase58(),
    ),
  );
});

test("a rejected root or proof node is caught before it reaches the chain", () => {
  assert.throws(
    () =>
      publishEpochIx({
        authority: alice,
        mint: MINT,
        index: 0n,
        root: new Uint8Array(31),
        total: 1n,
        claimants: 1,
        deadline: 1,
      }),
    /32 bytes/,
  );

  assert.throws(
    () =>
      claimIx({
        claimant: alice,
        mint: MINT,
        index: 0n,
        amount: 1n,
        proof: [new Uint8Array(31)],
        claimantToken: bob,
      }),
    /32 bytes/,
  );
});

test("a vault account decodes back to the fields the program wrote", () => {
  const data = Buffer.alloc(8 + 32 * 3 + 8 * 4 + 2);
  Buffer.from(ACCOUNT_DISCRIMINATOR.vault).copy(data, 0);
  alice.toBuffer().copy(data, 8);
  MINT.toBuffer().copy(data, 40);
  bob.toBuffer().copy(data, 72);
  data.writeBigUInt64LE(4n, 104); // epoch_count
  data.writeBigUInt64LE(1_000n, 112); // total_funded
  data.writeBigUInt64LE(250n, 120); // total_claimed
  data.writeBigUInt64LE(300n, 128); // reserved
  data[136] = 254;
  data[137] = 253;

  const vault = decodeVault(alice, data);
  assert.ok(vault.authority.equals(alice));
  assert.ok(vault.mint.equals(MINT));
  assert.ok(vault.tokenAccount.equals(bob));
  assert.equal(vault.epochCount, 4n);
  assert.equal(vault.totalFunded, 1_000n);
  assert.equal(vault.totalClaimed, 250n);
  assert.equal(vault.reserved, 300n);
  assert.equal(vault.bump, 254);
  assert.equal(vault.fundsBump, 253);

  // Free balance is what a new epoch can promise, and it never reads as negative.
  assert.equal(unreserved(vault, 750n), 450n);
  assert.equal(unreserved(vault, 300n), 0n);
  assert.equal(unreserved(vault, 10n), 0n);

  data[0] ^= 0xff;
  assert.throws(() => decodeVault(alice, data), /not a vault/);
});

test("an epoch account decodes back to the fields the program wrote", () => {
  const data = Buffer.alloc(8 + 32 + 8 + 32 + 8 + 8 + 4 + 4 + 8 + 8 + 1 + 1);
  Buffer.from(ACCOUNT_DISCRIMINATOR.epoch).copy(data, 0);
  alice.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(7n, 40);
  Buffer.alloc(32, 0x5a).copy(data, 48);
  data.writeBigUInt64LE(5_000n, 80);
  data.writeBigUInt64LE(1_200n, 88);
  data.writeUInt32LE(40, 96);
  data.writeUInt32LE(9, 100);
  data.writeBigInt64LE(1_757_000_000n, 104);
  data.writeBigInt64LE(1_759_592_000n, 112);
  data[120] = 0;
  data[121] = 255;

  const epoch = decodeEpoch(alice, data);
  assert.equal(epoch.index, 7n);
  assert.deepEqual(Array.from(epoch.root), Array(32).fill(0x5a));
  assert.equal(epoch.total, 5_000n);
  assert.equal(epoch.claimed, 1_200n);
  assert.equal(epoch.claimants, 40);
  assert.equal(epoch.claimedCount, 9);
  assert.equal(epoch.publishedAt.getTime(), 1_757_000_000_000);
  assert.equal(epoch.deadline.getTime(), 1_759_592_000_000);
  assert.equal(epoch.closed, false);
  assert.equal(epoch.bump, 255);

  data[120] = 1;
  assert.equal(decodeEpoch(alice, data).closed, true);
});
