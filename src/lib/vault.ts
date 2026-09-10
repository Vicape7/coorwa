/**
 * Client for the Corwa cashback vault (`programs/corwa-vault`).
 *
 * Deliberately written against the wire format rather than against a generated IDL. The vault is a
 * handful of instructions with fixed layouts, and hand-encoding them means the app never has to
 * ship a build artefact of the program to know how to talk to it: the browser bundle stays small,
 * and a stale IDL can never silently disagree with the deployed code. The discriminators below are
 * the same eight bytes Anchor derives, and `tests/vault-layout.test.ts` recomputes every one of
 * them from the instruction name, so this file cannot drift without a test going red.
 *
 * Reading is safe from anywhere. Writing is a plain instruction the user's own wallet signs, the
 * same as every other transaction Corwa builds.
 */
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { VAULT_PROGRAM_ADDRESS } from "./config";

export const VAULT_PROGRAM_ID = new PublicKey(VAULT_PROGRAM_ADDRESS);

// --- discriminators ----------------------------------------------------------------------------

/** sha256("global:<instruction>")[0..8], the way Anchor dispatches. */
const IX = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  fund: [218, 188, 111, 221, 152, 113, 174, 7],
  publishEpoch: [222, 6, 136, 82, 54, 246, 245, 120],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  closeEpoch: [13, 87, 7, 133, 109, 14, 83, 25],
  setAuthority: [133, 250, 37, 21, 110, 163, 26, 121],
} as const;

/** sha256("account:<Struct>")[0..8], the tag every account carries in its first eight bytes. */
export const ACCOUNT_DISCRIMINATOR = {
  vault: [211, 8, 232, 43, 2, 152, 117, 119],
  epoch: [93, 83, 120, 89, 151, 138, 152, 108],
  claimStatus: [22, 183, 249, 157, 247, 95, 150, 96],
} as const;

// --- seeds and addresses -----------------------------------------------------------------------

const VAULT_SEED = new TextEncoder().encode("vault");
const FUNDS_SEED = new TextEncoder().encode("funds");
const EPOCH_SEED = new TextEncoder().encode("epoch");
const CLAIM_SEED = new TextEncoder().encode("claim");

function u64le(value: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

/** One vault per mint, so its address follows from the mint and nothing has to be configured. */
export function vaultPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, mint.toBytes()], VAULT_PROGRAM_ID)[0];
}

export function fundsPda(vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([FUNDS_SEED, vault.toBytes()], VAULT_PROGRAM_ID)[0];
}

export function epochPda(vault: PublicKey, index: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [EPOCH_SEED, vault.toBytes(), u64le(index)],
    VAULT_PROGRAM_ID,
  )[0];
}

/** Exists only once a wallet has claimed that epoch, which is what stops a second attempt. */
export function claimStatusPda(epoch: PublicKey, claimant: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CLAIM_SEED, epoch.toBytes(), claimant.toBytes()],
    VAULT_PROGRAM_ID,
  )[0];
}

// --- account state -----------------------------------------------------------------------------

export interface VaultState {
  address: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  epochCount: bigint;
  totalFunded: bigint;
  totalClaimed: bigint;
  /** Committed to open epochs. The vault's token balance is always at least this. */
  reserved: bigint;
  bump: number;
  fundsBump: number;
}

export interface EpochState {
  address: PublicKey;
  vault: PublicKey;
  index: bigint;
  root: Uint8Array;
  total: bigint;
  claimed: bigint;
  claimants: number;
  claimedCount: number;
  publishedAt: Date;
  deadline: Date;
  closed: boolean;
  bump: number;
}

export interface ClaimStatusState {
  epoch: PublicKey;
  claimant: PublicKey;
  amount: bigint;
  claimedAt: Date;
}

class Reader {
  private readonly data: Uint8Array;
  private offset = 8; // past the discriminator

  constructor(data: Uint8Array) {
    this.data = data;
  }

  key(): PublicKey {
    const k = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return k;
  }
  bytes32(): Uint8Array {
    const b = this.data.slice(this.offset, this.offset + 32);
    this.offset += 32;
    return b;
  }
  u64(): bigint {
    const v = this.view().getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    const v = this.view().getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  u32(): number {
    const v = this.view().getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u8(): number {
    return this.data[this.offset++];
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  private view() {
    return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
}

function checkTag(data: Uint8Array, tag: readonly number[], what: string) {
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== tag[i]) throw new Error(`that account is not a ${what}`);
  }
}

export function decodeVault(address: PublicKey, data: Uint8Array): VaultState {
  checkTag(data, ACCOUNT_DISCRIMINATOR.vault, "vault");
  const r = new Reader(data);
  return {
    address,
    authority: r.key(),
    mint: r.key(),
    tokenAccount: r.key(),
    epochCount: r.u64(),
    totalFunded: r.u64(),
    totalClaimed: r.u64(),
    reserved: r.u64(),
    bump: r.u8(),
    fundsBump: r.u8(),
  };
}

export function decodeEpoch(address: PublicKey, data: Uint8Array): EpochState {
  checkTag(data, ACCOUNT_DISCRIMINATOR.epoch, "cashback epoch");
  const r = new Reader(data);
  return {
    address,
    vault: r.key(),
    index: r.u64(),
    root: r.bytes32(),
    total: r.u64(),
    claimed: r.u64(),
    claimants: r.u32(),
    claimedCount: r.u32(),
    publishedAt: new Date(Number(r.i64()) * 1000),
    deadline: new Date(Number(r.i64()) * 1000),
    closed: r.bool(),
    bump: r.u8(),
  };
}

export function decodeClaimStatus(data: Uint8Array): ClaimStatusState {
  checkTag(data, ACCOUNT_DISCRIMINATOR.claimStatus, "claim record");
  const r = new Reader(data);
  return { epoch: r.key(), claimant: r.key(), amount: r.u64(), claimedAt: new Date(Number(r.i64()) * 1000) };
}

/** What the vault could still back with a new epoch. Everything else is already promised. */
export function unreserved(vault: VaultState, fundsBalance: bigint): bigint {
  return fundsBalance > vault.reserved ? fundsBalance - vault.reserved : 0n;
}

// --- instruction encoding ----------------------------------------------------------------------

class Writer {
  private readonly parts: Uint8Array[] = [];

  tag(disc: readonly number[]): this {
    this.parts.push(Uint8Array.from(disc));
    return this;
  }
  u64(value: bigint | number): this {
    this.parts.push(u64le(value));
    return this;
  }
  i64(value: bigint | number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(value), true);
    this.parts.push(b);
    return this;
  }
  u32(value: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value, true);
    this.parts.push(b);
    return this;
  }
  bytes(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }
  key(value: PublicKey): this {
    this.parts.push(value.toBytes());
    return this;
  }
  /** Borsh vectors are a u32 length followed by the elements. */
  vec32(items: Uint8Array[]): this {
    this.u32(items.length);
    for (const it of items) {
      if (it.length !== 32) throw new Error("a proof node must be 32 bytes");
      this.parts.push(it);
    }
    return this;
  }
  finish(): Buffer {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return Buffer.from(out);
  }
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey: PublicKey, writable = true): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: writable,
});

export function initializeIx(authority: PublicKey, mint: PublicKey): TransactionInstruction {
  const vault = vaultPda(mint);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [
      signer(authority),
      ro(mint),
      rw(vault),
      rw(fundsPda(vault)),
      ro(TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
      ro(SYSVAR_RENT_PUBKEY),
    ],
    data: new Writer().tag(IX.initialize).finish(),
  });
}

/**
 * Anyone may fund. There is no way back out except through a published epoch, so this is a gift to
 * whoever the next root names, and the panel says so before it asks for a signature.
 */
export function fundIx(
  funder: PublicKey,
  mint: PublicKey,
  funderToken: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const vault = vaultPda(mint);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [
      signer(funder),
      rw(vault),
      ro(mint),
      rw(fundsPda(vault)),
      rw(funderToken),
      ro(TOKEN_PROGRAM_ID),
    ],
    data: new Writer().tag(IX.fund).u64(amount).finish(),
  });
}

export interface PublishEpochArgs {
  authority: PublicKey;
  mint: PublicKey;
  index: bigint;
  root: Uint8Array;
  total: bigint;
  claimants: number;
  /** Last second a claim is accepted, as a unix timestamp in seconds. */
  deadline: number;
}

export function publishEpochIx(args: PublishEpochArgs): TransactionInstruction {
  if (args.root.length !== 32) throw new Error("a merkle root must be 32 bytes");

  const vault = vaultPda(args.mint);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [
      signer(args.authority),
      rw(vault),
      ro(fundsPda(vault)),
      rw(epochPda(vault, args.index)),
      ro(SystemProgram.programId),
    ],
    data: new Writer()
      .tag(IX.publishEpoch)
      .u64(args.index)
      .bytes(args.root)
      .u64(args.total)
      .u32(args.claimants)
      .i64(args.deadline)
      .finish(),
  });
}

export interface ClaimArgs {
  claimant: PublicKey;
  mint: PublicKey;
  index: bigint;
  amount: bigint;
  proof: Uint8Array[];
  /** The claimant's token account for the mint. Created by the program if it does not exist yet. */
  claimantToken: PublicKey;
}

export function claimIx(args: ClaimArgs): TransactionInstruction {
  const vault = vaultPda(args.mint);
  const epoch = epochPda(vault, args.index);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [
      signer(args.claimant),
      rw(vault),
      rw(epoch),
      rw(claimStatusPda(epoch, args.claimant)),
      ro(args.mint),
      rw(fundsPda(vault)),
      rw(args.claimantToken),
      ro(TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    data: new Writer().tag(IX.claim).u64(args.amount).vec32(args.proof).finish(),
  });
}

/**
 * The whole claim, ready to sign.
 *
 * The program will not create a token account for the claimant, deliberately: `init_if_needed` in
 * a program that moves money is a sharp edge nobody needs here. Instead the idempotent create runs
 * first in the same transaction, so a wallet with no COOK account yet claims in one signature and
 * pays its own rent, and a wallet that already has one pays nothing extra.
 */
export function claimInstructions(
  args: Omit<ClaimArgs, "claimantToken">,
): TransactionInstruction[] {
  const claimantToken = getAssociatedTokenAddressSync(args.mint, args.claimant);
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      args.claimant,
      claimantToken,
      args.claimant,
      args.mint,
    ),
    claimIx({ ...args, claimantToken }),
  ];
}

/** Permissionless. It returns an expired epoch's remainder to the vault and moves nothing else. */
export function closeEpochIx(mint: PublicKey, index: bigint): TransactionInstruction {
  const vault = vaultPda(mint);
  return new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [rw(vault), rw(epochPda(vault, index))],
    data: new Writer().tag(IX.closeEpoch).finish(),
  });
}

export function setAuthorityIx(
  authority: PublicKey,
  mint: PublicKey,
  newAuthority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [signer(authority, false), rw(vaultPda(mint))],
    data: new Writer().tag(IX.setAuthority).key(newAuthority).finish(),
  });
}
