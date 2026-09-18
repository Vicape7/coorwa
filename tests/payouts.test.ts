/**
 * The arithmetic of a payout run: who is paid now, and how many units of the asset each gets.
 *
 * Both halves move real tokens. A split that creates a unit tries to send one the operator does not
 * have and the whole batch fails; one that loses units leaves dust nobody is paid. A threshold that
 * groups wrongly either sends a holder a payout smaller than its token account's rent or never pays
 * them at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DUST_USD,
  lineAmounts,
  nextRunCouldPay,
  payableLines,
  splitRaw,
  waitingUsd,
  withoutCreators,
} from "../src/lib/rewards-ledger";
import {
  MAX_CYCLE_ATTEMPTS,
  MAX_LINE_ATTEMPTS,
  sendBatch,
  swapPortions,
} from "../src/lib/payout-cycle";

const sum = (m: Map<unknown, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

test("a split hands out exactly the total, never a unit more or less", () => {
  const shares = [
    { key: "a", usd: 1 },
    { key: "b", usd: 1 },
    { key: "c", usd: 1 },
  ];
  const out = splitRaw(100n, shares);
  assert.equal(sum(out), 100n);
  assert.deepEqual([...out.values()].sort(), [33n, 33n, 34n]);

  const odd = splitRaw(999_999_999_999n, [
    { key: "x", usd: 0.3333 },
    { key: "y", usd: 7.1 },
    { key: "z", usd: 0.0001 },
  ]);
  assert.equal(sum(odd), 999_999_999_999n);
});

test("a split follows the USD weights", () => {
  const out = splitRaw(1_000_000n, [
    { key: "big", usd: 3 },
    { key: "small", usd: 1 },
  ]);
  assert.equal(out.get("big"), 750_000n);
  assert.equal(out.get("small"), 250_000n);
});

test("nothing to split, or nobody to split it over, gives zeros", () => {
  assert.equal(sum(splitRaw(0n, [{ key: "a", usd: 5 }])), 0n);
  assert.equal(splitRaw(100n, [{ key: "a", usd: 0 }]).get("a"), 0n);
  assert.equal(splitRaw(100n, []).size, 0);
});

test("a wallet is paid once its lines in one asset reach the minimum together", () => {
  const lines = [
    { id: 1, wallet: "w1", ticker: "NVDA", amountUsd: 0.6 },
    { id: 2, wallet: "w1", ticker: "NVDA", amountUsd: 0.5 },
    { id: 3, wallet: "w2", ticker: "NVDA", amountUsd: 0.9 },
    { id: 4, wallet: "w1", ticker: "TSLA", amountUsd: 0.9 },
  ];
  assert.deepEqual(payableLines(lines, 1).sort(), [1, 2], "two tokens' lines add up; others wait");
  assert.deepEqual(payableLines(lines, 0.5).sort(), [1, 2, 3, 4]);
  assert.deepEqual(payableLines([], 1), []);
});

test("what a swap bought is shared per wallet, then per line, per asset", () => {
  const lines = [
    { id: 1, wallet: "w1", ticker: "NVDA", amountUsd: 2 },
    { id: 2, wallet: "w1", ticker: "NVDA", amountUsd: 1 },
    { id: 3, wallet: "w2", ticker: "NVDA", amountUsd: 1 },
    { id: 4, wallet: "w2", ticker: "TSLA", amountUsd: 5 },
  ];
  const out = lineAmounts(lines, new Map([["NVDA", 400n], ["TSLA", 77n]]));
  assert.equal(out.get(1), 200n);
  assert.equal(out.get(2), 100n);
  assert.equal(out.get(3), 100n);
  assert.equal(out.get(4), 77n, "a wallet alone in an asset gets all of it");
  assert.equal(sum(out), 477n);
});

test("an asset the run bought nothing of pays zero rather than failing", () => {
  const out = lineAmounts([{ id: 9, wallet: "w", ticker: "SPY", amountUsd: 3 }], new Map());
  assert.equal(out.get(9), 0n);
});

test("the creator is paid from fees only, never as a holder of their own token", () => {
  const weights = new Map([
    ["creator", 900n],
    ["holder", 100n],
  ]);
  const out = withoutCreators(weights, new Set(["creator"]));
  assert.deepEqual([...out], [["holder", 100n]]);
});

test("a pool left with rounding dust has nothing waiting, and a real cent still counts", () => {
  // COTE's pool as it stood on 2026-09-18: $1.02 accrued, all of it allocated but 2e-9.
  assert.equal(waitingUsd(1.0200000000000229, 1.0199999979600229), 0);
  assert.equal(waitingUsd(1, 1.5), 0);
  assert.ok(Math.abs(waitingUsd(1.01, 1) - 0.01) < 1e-12);
  assert.ok(waitingUsd(DUST_USD * 2, 0) > 0);
});

// --- a run that cannot finish -----------------------------------------------------------------------

/**
 * One wallet that cannot receive must not stop the run, and through it every later run: a step only
 * ever works on the oldest open run, so a send that fails forever means nobody is paid again.
 */
test("a batch is one transaction's worth of recipients, a wallet's lines together", () => {
  const pending = [
    { id: 1, wallet: "a", ticker: "NVDA", attempts: 0 },
    { id: 2, wallet: "a", ticker: "NVDA", attempts: 0 },
    { id: 3, wallet: "b", ticker: "NVDA", attempts: 0 },
    { id: 4, wallet: "a", ticker: "TSLA", attempts: 0 },
    { id: 5, wallet: "c", ticker: "NVDA", attempts: 0 },
  ];
  const batch = sendBatch(pending, 2);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0].map((l) => l.id), [1, 2]);
  assert.deepEqual(batch[1].map((l) => l.id), [3]);
});

test("a recipient whose send failed is sent on its own, so it cannot take the others down", () => {
  const pending = [
    { id: 1, wallet: "good", ticker: "NVDA", attempts: 0 },
    { id: 2, wallet: "bad", ticker: "NVDA", attempts: 2 },
    { id: 3, wallet: "alsogood", ticker: "NVDA", attempts: 0 },
  ];
  const batch = sendBatch(pending, 5);
  assert.deepEqual(batch, [[pending[1]]]);

  // Once it is left behind, the rest go together again.
  assert.equal(sendBatch(pending.filter((l) => l.id !== 2), 5).length, 2);
});

test("nothing pending is nothing to send", () => {
  assert.deepEqual(sendBatch([], 5), []);
});

test("a wallet is given up on before the run that is trying to pay it", () => {
  // The other way round, every run would stop on the same wallet and start over on the next one.
  assert.ok(MAX_LINE_ATTEMPTS < MAX_CYCLE_ATTEMPTS);
});

// --- what each swap of a run spends -------------------------------------------------------------------

const owed = (entries: [string, number][]) => new Map(entries);

test("with its costs covered by spare SOL, a run swaps everything it bridged into what it owes", () => {
  const out = swapPortions({
    bridged: 1_000_000n,
    balance: 1_000_000n,
    swapped: 0n,
    costUsd: 0,
    owedUsd: owed([["NVDA", 1.2], ["TSLA", 0.8]]),
  });
  assert.equal(out.get("SOL"), 0n);
  assert.equal(out.get("NVDA"), 600_000n);
  assert.equal(out.get("TSLA"), 400_000n);
});

test("costs the spare SOL does not cover come out of the run's own payouts", () => {
  const out = swapPortions({
    bridged: 1_000_000n,
    balance: 1_000_000n,
    swapped: 0n,
    costUsd: 0.5,
    owedUsd: owed([["NVDA", 1.5], ["TSLA", 0.5]]),
  });
  // A quarter of what the run owes is costs, so SOL gets a quarter and the assets split the rest 3:1.
  assert.equal(out.get("SOL"), 250_000n);
  assert.equal(out.get("NVDA"), 562_500n);
  assert.equal(out.get("TSLA"), 187_500n);
  assert.equal(sum(out), 1_000_000n);
});

test("a run never spends COOK beyond what it bridged, whatever else sits in the account", () => {
  const out = swapPortions({
    bridged: 1_000_000n,
    balance: 4_000_000n,
    swapped: 0n,
    costUsd: 0,
    owedUsd: owed([["NVDA", 1]]),
  });
  assert.equal(out.get("NVDA"), 1_000_000n);
});

test("a step that resumes after some swaps landed gives the rest the same portions", () => {
  const args = {
    bridged: 1_000_000n,
    costUsd: 0.4,
    owedUsd: owed([["NVDA", 1], ["TSLA", 1]]),
  };
  const first = swapPortions({ ...args, balance: 1_000_000n, swapped: 0n });
  // The SOL and NVDA swaps went through, then the TSLA one failed and the step was called again.
  const spent = first.get("SOL")! + first.get("NVDA")!;
  const again = swapPortions({ ...args, balance: 1_000_000n - spent, swapped: spent });
  assert.deepEqual([...again], [...first]);
});

test("a run that arrived short shares what did arrive, in the same proportions", () => {
  const out = swapPortions({
    bridged: 1_000_000n,
    balance: 600_000n,
    swapped: 0n,
    costUsd: 0,
    owedUsd: owed([["NVDA", 1], ["TSLA", 1]]),
  });
  assert.equal(out.get("NVDA"), 300_000n);
  assert.equal(out.get("TSLA"), 300_000n);
});

// --- Whether the next run sends anything -----------------------------------------------------------

function pool(ticker: string | null, holdersWaitingUsd: number, creatorLeftUsd = 0) {
  return {
    mint: `mint-${ticker}`,
    symbol: null,
    ticker,
    holdersAccruedUsd: holdersWaitingUsd,
    holdersAllocatedUsd: 0,
    holdersWaitingUsd,
    holdersPaidUsd: 0,
    creator: null,
    creatorAccruedUsd: creatorLeftUsd,
    creatorAllocatedUsd: 0,
    creatorPaidUsd: 0,
  };
}

test("a run where nobody can reach the minimum sends nothing, and says so", () => {
  // Today's ledger in miniature: small lines, a small pool, nobody near a dollar.
  const unpaid = [
    { wallet: "a", ticker: "NVDA", amountUsd: 0.2 },
    { wallet: "b", ticker: "NVDA", amountUsd: 0.1 },
  ];
  assert.equal(nextRunCouldPay(unpaid, [pool("NVDA", 0.3, 0.1)], 1), false);
});

test("a wallet whose lines and the waiting pool could reach the minimum may be paid", () => {
  const unpaid = [{ wallet: "a", ticker: "NVDA", amountUsd: 0.7 }];
  assert.equal(nextRunCouldPay(unpaid, [pool("NVDA", 0.2, 0.1)], 1), true);
  // Only the same asset counts: a TSLA pool does not lift an NVDA line.
  assert.equal(nextRunCouldPay(unpaid, [pool("TSLA", 0.9)], 1), false);
});

test("a waiting pool at the minimum can pay a wallet that has no lines yet", () => {
  assert.equal(nextRunCouldPay([], [pool("NVDA", 1)], 1), true);
});

test("a token with no pair waits, so its pool pays nobody at this run", () => {
  assert.equal(nextRunCouldPay([], [pool(null, 5)], 1), false);
});
