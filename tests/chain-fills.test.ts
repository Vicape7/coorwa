/**
 * Reading swaps out of real DAMM transactions on COOKL's pool, which the trade feed does not index.
 *
 * A swap is told apart from everything else a pool does by its vaults alone: one side in, the other
 * out. A fee claim moves only COOK out of the vaults and must not show up as a fill.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { swapFromTransaction, type RpcTransaction } from "../src/lib/chain-fills";

const COOKL = "62MbXm8LPfbYkhsQiwzpNHHHQvzhmmToLq9WhDPCmomo";

function load(name: string): RpcTransaction {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/damm/${name}.json`, import.meta.url), "utf8"),
  ) as RpcTransaction;
}

test("a buy takes tokens out of the pool and puts COOK in", () => {
  const swap = swapFromTransaction(load("cookl-buy"), COOKL);
  assert.ok(swap);
  assert.equal(swap.side, "buy");
  assert.equal(swap.tokens, 10019094.747477);
  assert.equal(swap.cook, 10842);
  assert.equal(swap.trader, "8J1icStkgmp3brTwmKnAAsP4cLgzo4fHuMwJZLZ15C34");
  assert.equal(swap.ts, 1789850046);
});

test("a sell puts tokens in and takes COOK out", () => {
  const swap = swapFromTransaction(load("cookl-sell"), COOKL);
  assert.ok(swap);
  assert.equal(swap.side, "sell");
  assert.equal(swap.tokens, 99163600.090236);
  assert.equal(swap.trader, "GG72gCzxLZWqcrMpd9YQjjK3pN1Pm1xZrxkPj9BEBqE3");
});

test("a fee claim is not a fill", () => {
  assert.equal(swapFromTransaction(load("cookl-claim-fee"), COOKL), null);
});

test("a swap of another token through the pool is not a fill of this one", () => {
  assert.equal(
    swapFromTransaction(load("cookl-buy"), "2wPK38gv8dWU89K5zDAAULAihnU1sRocbpzwPP6twY7Q"),
    null,
  );
});

test("a failed transaction is not a fill", () => {
  const tx = load("cookl-buy");
  assert.equal(swapFromTransaction({ ...tx, meta: { ...tx.meta!, err: { custom: 1 } } }, COOKL), null);
});
