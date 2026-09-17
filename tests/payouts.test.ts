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
import { lineAmounts, payableLines, splitRaw, withoutCreators } from "../src/lib/rewards-ledger";
import { MAX_CYCLE_ATTEMPTS, MAX_LINE_ATTEMPTS, sendBatch } from "../src/lib/payout-cycle";

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
