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
import {
  entitlementsFrom,
  holderAllocationsFrom,
  holderWeightsFrom,
  shouldSample,
  SAMPLE_CHANCE,
  SAMPLE_MAX_GAP_MS,
  SAMPLE_MIN_GAP_MS,
  listingsPerPair,
  toCook,
  type Accrual,
} from "../src/lib/epochs";
import { buildEpochTree, verifyProof } from "../src/lib/merkle";
import {
  CASHBACK_MIN_CLAIM_COOK,
  CASHBACK_SPLIT,
  COOK_DECIMALS,
} from "../src/lib/config";

const COOK_USD = 0.5;
const UNITS = 10 ** COOK_DECIMALS;

const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();

function accrual(over: Partial<Accrual> = {}): Accrual {
  return {
    holderUsd: new Map(),
    creatorUsd: new Map(),
    committedUsd: new Map(),
    cookPriceUsd: COOK_USD,
    ...over,
  };
}

/**
 * A share big enough to clear the claim floor several times over.
 *
 * These are shares, not fees: the split moved out to `computeEntitlements`, where the source of the
 * fee is known, because a launchpad referral and a swap fee are not split the same way. What is
 * left here is the part that must not be wrong whatever the split was - the subtraction, the
 * conversion and the floor.
 */
const HOLDER_SHARE = CASHBACK_MIN_CLAIM_COOK * COOK_USD * 20;
const CREATOR_SHARE = HOLDER_SHARE * (CASHBACK_SPLIT.creator / CASHBACK_SPLIT.holders);

test("a wallet is paid its share of what it generated, converted once", () => {
  const [line] = entitlementsFrom(accrual({ holderUsd: new Map([[A, HOLDER_SHARE]]) }));

  assert.equal(line.wallet, A);
  assert.equal(line.holderUsd, HOLDER_SHARE);
  assert.equal(line.creatorUsd, 0);
  assert.equal(line.amountUsd, HOLDER_SHARE);
  assert.equal(line.amountRaw, BigInt(Math.floor((line.amountUsd / COOK_USD) * UNITS)));
});

test("trading and launching add up on the same line", () => {
  const [line] = entitlementsFrom(
    accrual({
      holderUsd: new Map([[A, HOLDER_SHARE]]),
      creatorUsd: new Map([[A, CREATOR_SHARE]]),
    }),
  );

  // One leaf per wallet per epoch, because the program pays a wallet once and the merkle builder
  // refuses a duplicate outright.
  assert.equal(line.amountUsd, HOLDER_SHARE + CREATOR_SHARE);
});

test("a balance already sitting in an epoch is not offered again", () => {
  const earned = HOLDER_SHARE;
  const base = { holderUsd: new Map([[A, HOLDER_SHARE]]) };

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
      holderUsd: new Map([[A, HOLDER_SHARE]]),
      committedUsd: new Map([[A, HOLDER_SHARE * 10]]),
    }),
  );
  assert.deepEqual(lines, []);
});

test("dust waits for a later epoch instead of costing its claimant rent", () => {
  // Just under the floor: a claim writes two accounts the claimant pays for, so paying this out
  // would leave them worse off than not claiming.
  const justUnder = (CASHBACK_MIN_CLAIM_COOK - 0.001) * COOK_USD;
  assert.deepEqual(entitlementsFrom(accrual({ holderUsd: new Map([[A, justUnder]]) })), []);

  const justOver = (CASHBACK_MIN_CLAIM_COOK + 0.001) * COOK_USD;
  const [line] = entitlementsFrom(accrual({ holderUsd: new Map([[A, justOver]]) }));
  assert.ok(toCook(line.amountRaw) >= CASHBACK_MIN_CLAIM_COOK);
});

test("the same inputs always produce the same root", () => {
  const input = accrual({
    holderUsd: new Map([
      [A, HOLDER_SHARE],
      [B, HOLDER_SHARE * 3],
    ]),
    creatorUsd: new Map([[B, CREATOR_SHARE]]),
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
      holderUsd: new Map(
        Array.from({ length: 9 }, () => [Keypair.generate().publicKey.toBase58(), HOLDER_SHARE]),
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

test("the split returns the whole fee to holders and creator", () => {
  // A split that does not sum to 1 either invents money or quietly keeps some.
  const total = Object.values(CASHBACK_SPLIT).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `split sums to ${total}`);
  assert.deepEqual(Object.keys(CASHBACK_SPLIT).sort(), ["creator", "holders"]);
});

// --- holder pools ----------------------------------------------------------------------------------

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

test("a token's pool is shared over its holders in proportion to what they hold", () => {
  const rows = holderAllocationsFrom({
    waitingByMint: new Map([["mintA", 10]]),
    holders: new Map([
      [
        "mintA",
        new Map([
          ["alice", 3_000_000n],
          ["bob", 1_000_000n],
        ]),
      ],
    ]),
  });
  const by = new Map(rows.map((r) => [r.wallet, r.amountUsd]));
  assert.equal(by.get("alice"), 7.5);
  assert.equal(by.get("bob"), 2.5);
  assert.equal(rows.find((r) => r.wallet === "alice")?.balanceRaw, 3_000_000n);
});

test("holding one token earns nothing from another token's pool", () => {
  const rows = holderAllocationsFrom({
    waitingByMint: new Map([
      ["mintA", 4],
      ["mintB", 6],
    ]),
    holders: new Map([
      ["mintA", new Map([["alice", 1n]])],
      ["mintB", new Map([["bob", 1n]])],
    ]),
  });
  assert.deepEqual(
    rows.map((r) => [r.mint, r.wallet, r.amountUsd]),
    [
      ["mintA", "alice", 4],
      ["mintB", "bob", 6],
    ],
  );
});

test("a pool nobody holds, or with nothing waiting, allocates nothing and waits", () => {
  assert.deepEqual(
    holderAllocationsFrom({
      waitingByMint: new Map([["mintA", 5]]),
      holders: new Map([["mintA", new Map()]]),
    }),
    [],
  );
  assert.deepEqual(
    holderAllocationsFrom({
      waitingByMint: new Map([["mintA", 0]]),
      holders: new Map([["mintA", new Map([["alice", 10n]])]]),
    }),
    [],
  );
});

test("allocations never add up to more than the pool, even on a huge supply", () => {
  const holders = new Map<string, bigint>();
  for (let i = 0; i < 7; i += 1) holders.set(`w${i}`, 333_333_333_333_333n + BigInt(i));
  const rows = holderAllocationsFrom({
    waitingByMint: new Map([["mintA", 1]]),
    holders: new Map([["mintA", holders]]),
  });
  const sum = rows.reduce((s, r) => s + r.amountUsd, 0);
  assert.ok(sum <= 1 && sum > 0.999999, `allocated ${sum}`);
});

test("one payment that bought three pairs is a third of the money per pair", () => {
  const rows = ["AAPL", "TSLA", "SPY"].map((ticker) => ({
    mint: "mintA",
    ticker,
    signature: "sig1",
    paidUsd: 3.06,
    at: day(1),
  }));
  const per = listingsPerPair(rows);
  assert.deepEqual(
    per.map((l) => [l.pair, Number(l.paidUsd.toFixed(2))]),
    [
      ["mintA|AAPL", 1.02],
      ["mintA|TSLA", 1.02],
      ["mintA|SPY", 1.02],
    ],
  );
});

// --- holder samples --------------------------------------------------------------------------------

test("a wallet that held for part of the epoch weighs that part of one that held throughout", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 1, h));
  const rows = [
    { takenAt: at(1), wallet: "steady", balanceRaw: 100n },
    { takenAt: at(2), wallet: "steady", balanceRaw: 100n },
    { takenAt: at(3), wallet: "steady", balanceRaw: 100n },
    // Bought just before one sample and sold after it.
    { takenAt: at(2), wallet: "flipper", balanceRaw: 100n },
  ];
  const { weights, samples } = holderWeightsFrom(rows, new Map([["steady", 100n]]));
  assert.equal(samples, 4, "three samples plus the snapshot taken as the epoch is built");
  assert.equal(weights.get("steady"), 400n);
  assert.equal(weights.get("flipper"), 100n);

  const rewards = holderAllocationsFrom({
    waitingByMint: new Map([["mintA", 5]]),
    holders: new Map([["mintA", weights]]),
  });
  const by = new Map(rewards.map((r) => [r.wallet, r.amountUsd]));
  assert.equal(by.get("steady"), 4);
  assert.equal(by.get("flipper"), 1);
});

test("with no samples the epoch falls back to the snapshot it takes itself", () => {
  const { weights, samples } = holderWeightsFrom([], new Map([["alice", 7n]]));
  assert.equal(samples, 1);
  assert.deepEqual([...weights], [["alice", 7n]]);
});

test("a sample is never taken twice inside the minimum gap, and always after the maximum", () => {
  const now = new Date(Date.UTC(2026, 8, 1, 12));
  const ago = (ms: number) => new Date(now.getTime() - ms);
  assert.equal(shouldSample(null, now, 0.99), true, "the first sample is always taken");
  assert.equal(shouldSample(ago(SAMPLE_MIN_GAP_MS - 1), now, 0), false);
  assert.equal(shouldSample(ago(SAMPLE_MAX_GAP_MS), now, 0.99), true);
  const between = ago((SAMPLE_MIN_GAP_MS + SAMPLE_MAX_GAP_MS) / 2);
  assert.equal(shouldSample(between, now, SAMPLE_CHANCE - 0.01), true);
  assert.equal(shouldSample(between, now, SAMPLE_CHANCE + 0.01), false);
});

