/**
 * The accounting behind an epoch.
 *
 * The tree is already covered by `merkle.test.ts`; what is left is the arithmetic that decides
 * what goes into it, and that is where a bug costs real money rather than a failed transaction.
 * Paying a balance twice, paying an amount the vault cannot back, or handing out a proof the
 * program will not accept are all silent until somebody claims.
 *
 * Offline by design: the netting is a pure function of three maps, so none of this needs Postgres.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { entitlementsFrom, toCook, type Accrual } from "../src/lib/epochs";
import { buildEpochTree, verifyProof } from "../src/lib/merkle";
import { CASHBACK_MIN_CLAIM_COOK, CASHBACK_SPLIT, COOK_DECIMALS } from "../src/lib/config";

const COOK_USD = 0.5;
const UNITS = 10 ** COOK_DECIMALS;

const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();

function accrual(over: Partial<Accrual> = {}): Accrual {
  return {
    traderFeesUsd: new Map(),
    creatorFeesUsd: new Map(),
    committedUsd: new Map(),
    cookPriceUsd: COOK_USD,
    ...over,
  };
}

/** A fee big enough that the trader's half clears the claim floor several times over. */
const BIG_FEE = (CASHBACK_MIN_CLAIM_COOK * COOK_USD * 20) / CASHBACK_SPLIT.trader;

test("a wallet is paid its share of what it generated, converted once", () => {
  const [line] = entitlementsFrom(accrual({ traderFeesUsd: new Map([[A, BIG_FEE]]) }));

  assert.equal(line.wallet, A);
  assert.equal(line.traderUsd, BIG_FEE * CASHBACK_SPLIT.trader);
  assert.equal(line.creatorUsd, 0);
  assert.equal(line.amountUsd, BIG_FEE * CASHBACK_SPLIT.trader);
  assert.equal(line.amountRaw, BigInt(Math.floor((line.amountUsd / COOK_USD) * UNITS)));
});

test("trading and launching add up on the same line", () => {
  const [line] = entitlementsFrom(
    accrual({
      traderFeesUsd: new Map([[A, BIG_FEE]]),
      creatorFeesUsd: new Map([[A, BIG_FEE]]),
    }),
  );

  // One leaf per wallet per epoch, because the program pays a wallet once and the merkle builder
  // refuses a duplicate outright.
  assert.equal(line.amountUsd, BIG_FEE * (CASHBACK_SPLIT.trader + CASHBACK_SPLIT.creator));
});

test("a balance already sitting in an epoch is not offered again", () => {
  const earned = BIG_FEE * CASHBACK_SPLIT.trader;
  const base = { traderFeesUsd: new Map([[A, BIG_FEE]]) };

  // The whole balance is committed, so there is nothing left to publish.
  assert.deepEqual(
    entitlementsFrom(accrual({ ...base, committedUsd: new Map([[A, earned]]) })),
    [],
  );

  // Half of it is, so only the other half is.
  const [line] = entitlementsFrom(accrual({ ...base, committedUsd: new Map([[A, earned / 2]]) }));
  assert.ok(Math.abs(line.amountUsd - earned / 2) < 1e-9);
});

test("a wallet that has been paid more than it earned is skipped, never negative", () => {
  const lines = entitlementsFrom(
    accrual({
      traderFeesUsd: new Map([[A, BIG_FEE]]),
      committedUsd: new Map([[A, BIG_FEE * 10]]),
    }),
  );
  assert.deepEqual(lines, []);
});

test("dust waits for a later epoch instead of costing its claimant rent", () => {
  // Just under the floor: a claim writes two accounts the claimant pays for, so paying this out
  // would leave them worse off than not claiming.
  const justUnder = ((CASHBACK_MIN_CLAIM_COOK - 0.001) * COOK_USD) / CASHBACK_SPLIT.trader;
  assert.deepEqual(entitlementsFrom(accrual({ traderFeesUsd: new Map([[A, justUnder]]) })), []);

  const justOver = ((CASHBACK_MIN_CLAIM_COOK + 0.001) * COOK_USD) / CASHBACK_SPLIT.trader;
  const [line] = entitlementsFrom(accrual({ traderFeesUsd: new Map([[A, justOver]]) }));
  assert.ok(toCook(line.amountRaw) >= CASHBACK_MIN_CLAIM_COOK);
});

test("the same inputs always produce the same root", () => {
  const input = accrual({
    traderFeesUsd: new Map([
      [A, BIG_FEE],
      [B, BIG_FEE * 3],
    ]),
    creatorFeesUsd: new Map([[B, BIG_FEE]]),
  });

  // Republishing after a crash has to land on the same root, or every proof handed out before it
  // stops working. Nothing about the order the maps were built in may leak into the tree.
  const first = entitlementsFrom(input);
  const second = entitlementsFrom(input);
  const root = (lines: typeof first) =>
    buildEpochTree(
      lines.map((l) => ({ wallet: l.wallet, amount: l.amountRaw })),
      7n,
    ).root;

  assert.ok(root(first).equals(root(second)));
});

test("a proof survives the trip to the browser as hex and back", () => {
  const lines = entitlementsFrom(
    accrual({
      traderFeesUsd: new Map(
        Array.from({ length: 9 }, () => [Keypair.generate().publicKey.toBase58(), BIG_FEE]),
      ),
    }),
  );
  const index = 3n;
  const tree = buildEpochTree(
    lines.map((l) => ({ wallet: l.wallet, amount: l.amountRaw })),
    index,
  );

  for (const l of lines) {
    // The API serialises each node as hex and the rewards page parses it back before signing.
    const wire = tree.proofFor(l.wallet).map((n) => n.toString("hex"));
    const back = wire.map((h) => Buffer.from(h, "hex"));

    assert.ok(wire.every((h) => h.length === 64));
    assert.ok(verifyProof(tree.root, index, l.wallet, l.amountRaw, back));
  }
});

test("a missing COOK price is refused rather than guessed", () => {
  assert.throws(() => entitlementsFrom(accrual({ cookPriceUsd: 0 })), /COOK price/);
});
