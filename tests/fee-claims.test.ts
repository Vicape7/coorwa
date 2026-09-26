/**
 * Claiming the launch program's fees.
 *
 * The pool claim is measured by simulating it against the chain, so it is checked there (see
 * `npm run launch:claim`). What is pinned here is the curve claim, which is decided from the curve
 * account alone: when it is worth sending, and that it pays where the config says rather than
 * wherever the payer would like.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { FEE_CLAIM_MIN_COOK, planCurveFeeClaim } from "../src/lib/fee-claims";
import { LAUNCH_PROGRAM_ID, type CurveState } from "../src/lib/launch-program";

const mint = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;

function curve(feesQuote: bigint): CurveState {
  return {
    address: PublicKey.default,
    config: PublicKey.default,
    creator: Keypair.generate().publicKey,
    mint,
    baseVault: PublicKey.default,
    quoteVault: PublicKey.default,
    virtualBase: 1n,
    virtualQuote: 1n,
    saleBase: 1n,
    migrationBase: 1n,
    graduationQuote: 1n,
    baseSold: 0n,
    quoteRaised: 0n,
    feesQuote,
    taxBps: 300,
    curveFeeBps: 100,
    creatorLpShareBps: 4000,
    state: "live",
    createdAt: 0,
    positionNftMint: PublicKey.default,
  };
}

test("a curve fee under the minimum waits for the next pass", () => {
  const plan = planCurveFeeClaim(curve(FEE_CLAIM_MIN_COOK - 1n), payer, recipient);
  assert.equal(plan.kind, "none");
});

test("a curve fee at the minimum is claimed whole, to the fee recipient's wrapped COOK", () => {
  const plan = planCurveFeeClaim(curve(FEE_CLAIM_MIN_COOK), payer, recipient);
  assert.equal(plan.kind, "curve");
  if (plan.kind !== "curve") return;
  assert.equal(plan.toPlatform, FEE_CLAIM_MIN_COOK);
  assert.equal(plan.toCreator, 0n);

  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, recipient, true);
  const [open, claim] = plan.instructions;
  // The recipient's account is opened for the recipient, whoever pays for it.
  assert.ok(open.keys.some((k) => k.pubkey.equals(wrapped)));
  assert.ok(open.keys.some((k) => k.pubkey.equals(recipient)));
  assert.ok(claim.programId.equals(LAUNCH_PROGRAM_ID));
  assert.ok(claim.keys.some((k) => k.pubkey.equals(wrapped) && k.isWritable));
  assert.ok(!claim.keys.some((k) => k.pubkey.equals(payer)), "the payer is not a party to the claim");
});
