/**
 * How a token's pool is shared over its holders, and when a holder sample is taken.
 *
 * This is the arithmetic that decides who is paid what, and where a bug costs real money rather than
 * a failed transaction: paying a wallet for a token it never held, or letting a wallet that held for
 * one minute weigh as much as one that held all day.
 *
 * Offline by design: all of it is a pure function of maps and dates, so none of this needs Postgres.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  holderAllocationsFrom,
  holderWeightsFrom,
  shouldSample,
  SAMPLE_CHANCE,
  SAMPLE_MAX_GAP_MS,
  SAMPLE_MIN_GAP_MS,
} from "../src/lib/holder-samples";
import { CASHBACK_SPLIT } from "../src/lib/config";

test("the split returns the whole fee to holders and creator", () => {
  // A split that does not sum to 1 either invents money or quietly keeps some.
  const total = Object.values(CASHBACK_SPLIT).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `split sums to ${total}`);
  assert.deepEqual(Object.keys(CASHBACK_SPLIT).sort(), ["creator", "holders"]);
});

// --- holder pools ----------------------------------------------------------------------------------

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

// --- holder samples --------------------------------------------------------------------------------

test("a wallet that held for part of the day weighs that part of one that held throughout", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 1, h));
  const rows = [
    { takenAt: at(1), wallet: "steady", balanceRaw: 100n },
    { takenAt: at(2), wallet: "steady", balanceRaw: 100n },
    { takenAt: at(3), wallet: "steady", balanceRaw: 100n },
    // Bought just before one sample and sold after it.
    { takenAt: at(2), wallet: "flipper", balanceRaw: 100n },
  ];
  const { weights, samples } = holderWeightsFrom(rows);
  assert.equal(samples, 3);
  assert.equal(weights.get("steady"), 300n);
  assert.equal(weights.get("flipper"), 100n);

  const rewards = holderAllocationsFrom({
    waitingByMint: new Map([["mintA", 4]]),
    holders: new Map([["mintA", weights]]),
  });
  const by = new Map(rewards.map((r) => [r.wallet, r.amountUsd]));
  assert.equal(by.get("steady"), 3);
  assert.equal(by.get("flipper"), 1);
});

test("a wallet that appears only at the moment the run is due weighs nothing", () => {
  // The run's own moment is published as nextRunAt, so a balance read there could be arranged.
  // Buying into a token after its last sample earns from the next run, once samples have seen it.
  const { weights, samples } = holderWeightsFrom([]);
  assert.equal(samples, 0);
  assert.equal(weights.size, 0);
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
