/**
 * Checks the hand-written client against the compiler's own description of the program.
 *
 * `src/lib/vault.ts` encodes instructions by hand instead of driving a generated client, which is
 * the right trade for a program this small but only holds while the two agree. So every instruction
 * is built here and compared, field by field, with `programs/corwa-vault/idl.json` as Anchor emits
 * it: the dispatch bytes, the account list in order, which accounts sign, which are written, the
 * program addresses that are fixed, and the argument types.
 *
 * That makes the failure mode a red test rather than a reverted transaction. If someone reorders an
 * account in the program and rebuilds, this file goes red on the next run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATOR,
  VAULT_PROGRAM_ID,
  claimIx,
  closeEpochIx,
  fundIx,
  initializeIx,
  publishEpochIx,
  setAuthorityIx,
} from "../src/lib/vault";

interface IdlAccount {
  name: string;
  signer?: boolean;
  writable?: boolean;
  address?: string;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
  args: { name: string; type: unknown }[];
}
interface Idl {
  address: string;
  instructions: IdlInstruction[];
  accounts: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string; msg: string }[];
}

const idl: Idl = JSON.parse(
  readFileSync(new URL("../programs/corwa-vault/idl.json", import.meta.url), "utf8"),
);

const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const alice = Keypair.generate().publicKey;
const bob = Keypair.generate().publicKey;

const built: Record<string, TransactionInstruction> = {
  initialize: initializeIx(alice, MINT),
  fund: fundIx(alice, MINT, bob, 1_000n),
  publish_epoch: publishEpochIx({
    authority: alice,
    mint: MINT,
    index: 0n,
    root: new Uint8Array(32).fill(3),
    total: 1n,
    claimants: 1,
    deadline: 1_800_000_000,
  }),
  claim: claimIx({
    claimant: alice,
    mint: MINT,
    index: 0n,
    amount: 1n,
    proof: [],
    claimantToken: bob,
  }),
  close_epoch: closeEpochIx(MINT, 0n),
  set_authority: setAuthorityIx(alice, MINT, bob),
};

test("the client knows every instruction the program exposes, and no others", () => {
  assert.deepEqual(
    idl.instructions.map((i) => i.name).sort(),
    Object.keys(built).sort(),
    "the program and the client disagree about which instructions exist",
  );
});

for (const spec of idl.instructions) {
  test(`${spec.name} matches the IDL`, () => {
    const ix = built[spec.name];

    assert.deepEqual(
      Array.from(ix.data.subarray(0, 8)),
      spec.discriminator,
      "wrong discriminator, so this would dispatch to another instruction",
    );

    assert.equal(
      ix.keys.length,
      spec.accounts.length,
      `expected ${spec.accounts.length} accounts (${spec.accounts.map((a) => a.name).join(", ")})`,
    );

    spec.accounts.forEach((want, i) => {
      const got = ix.keys[i];
      assert.equal(got.isSigner, Boolean(want.signer), `${spec.name}.${want.name} signer flag`);
      assert.equal(got.isWritable, Boolean(want.writable), `${spec.name}.${want.name} writable flag`);
      // Accounts the program pins to one address are the ones a caller could most easily get
      // wrong, so they are compared by value rather than by position alone.
      if (want.address) {
        assert.equal(got.pubkey.toBase58(), want.address, `${spec.name}.${want.name} address`);
      }
    });
  });
}

test("instruction data is exactly as long as the arguments require", () => {
  const size = (type: unknown): number => {
    if (type === "u64" || type === "i64") return 8;
    if (type === "u32") return 4;
    if (type === "pubkey") return 32;
    if (typeof type === "object" && type !== null && "array" in type) {
      const [, len] = (type as { array: [unknown, number] }).array;
      return len;
    }
    throw new Error(`no fixed size for ${JSON.stringify(type)}`);
  };

  for (const spec of idl.instructions) {
    // Vectors are variable length, so those instructions are pinned by their own test instead.
    if (spec.args.some((a) => typeof a.type === "object" && a.type !== null && "vec" in a.type)) {
      continue;
    }
    const expected = 8 + spec.args.reduce((n, a) => n + size(a.type), 0);
    assert.equal(built[spec.name].data.length, expected, `${spec.name} argument bytes`);
  }
});

test("account tags and the program address match the build", () => {
  const tag = (name: string) => idl.accounts.find((a) => a.name === name)?.discriminator;

  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.vault), tag("Vault"));
  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.epoch), tag("Epoch"));
  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.claimStatus), tag("ClaimStatus"));

  assert.equal(
    idl.address,
    VAULT_PROGRAM_ID.toBase58(),
    "the built program and the configured address are different programs",
  );
});

test("the program still has no way to pay its own authority", () => {
  // The claim about custody rests on this. Anything that could move tokens to an arbitrary
  // destination would have to appear here first, and it would be visible in this list.
  assert.deepEqual(idl.instructions.map((i) => i.name).sort(), [
    "claim",
    "close_epoch",
    "fund",
    "initialize",
    "publish_epoch",
    "set_authority",
  ]);

  // close_epoch moves nothing and asks nobody to sign, which is what keeps a lost authority key
  // from stranding every unclaimed reserve.
  const close = idl.instructions.find((i) => i.name === "close_epoch");
  assert.ok(close && close.accounts.every((a) => !a.signer));
});
