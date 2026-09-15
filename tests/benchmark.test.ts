/**
 * Which assets a token may be quoted against, and what an extra one costs.
 *
 * This is the rule that decides what the terminal is: a list of markets somebody chose, or every
 * token multiplied by every asset. Getting it wrong is quiet rather than loud. Too loose and a
 * creator's benchmark stops meaning anything and the noise comes back; too tight and a token
 * disappears. The narrowing case matters most, because that is what makes `findPair` refuse a slug
 * for a pair nobody chose and nobody paid for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { quotesFor } from "../src/lib/pairs";
import { billableTickers, pairsPaidFor, listingQuote } from "../src/lib/listings";
import { PAIR_LISTING_USD } from "../src/lib/config";

const ALL = [{ ticker: "NVDA" }, { ticker: "TSLA" }, { ticker: "SPY" }] as const;
const [nvda, tsla, spy] = ALL.map((a) => a.ticker);

test("a token nobody chose a pair for carries none", () => {
  // No free benchmark: a token is not in the terminal until somebody buys it a pair.
  assert.deepEqual(quotesFor(undefined, undefined, ALL), []);
  assert.deepEqual(quotesFor(undefined, [], ALL), []);
});

test("a token carries exactly the pairs bought for it", () => {
  assert.deepEqual(quotesFor(undefined, [tsla], ALL), [{ ticker: tsla }]);
  assert.deepEqual(quotesFor(undefined, [tsla, spy], ALL), [{ ticker: tsla }, { ticker: spy }]);
});

test("a token launched here carries its own benchmark, and can be bought more", () => {
  assert.deepEqual(quotesFor(tsla, undefined, ALL), [{ ticker: tsla }]);
  const carried = quotesFor(tsla, [spy], ALL).map((a) => a.ticker);
  assert.deepEqual(carried.sort(), [spy, tsla].sort(), "a bought pair adds to the launch benchmark");
});

test("asking for an asset a token does not carry comes back empty", () => {
  // The fallback to be avoided: answering with the full set would resolve slugs nobody chose.
  assert.deepEqual(quotesFor(undefined, [tsla], [{ ticker: nvda }]), []);
  assert.deepEqual(quotesFor(tsla, undefined, [{ ticker: spy }]), []);
  assert.deepEqual(quotesFor("GONE", undefined, ALL), []);
});

test("nobody is charged for a pair the token already has", () => {
  assert.deepEqual(billableTickers([nvda], []), [nvda], "the first pair is paid for like any other");
  assert.deepEqual(billableTickers([tsla], [tsla]), [], "a launch benchmark or a bought pair");
  assert.deepEqual(billableTickers([tsla, spy], [tsla]), [spy]);
});

test("a repeated or unknown ticker cannot inflate the bill", () => {
  assert.deepEqual(billableTickers([tsla, tsla, tsla], []), [tsla]);
  assert.deepEqual(billableTickers(["NOTATHING"], []), []);
  assert.deepEqual(billableTickers([], []), []);
});

test("a payment buys what it covers, and a hair under the line still counts", () => {
  assert.equal(pairsPaidFor(0), 0);
  assert.equal(pairsPaidFor(PAIR_LISTING_USD * 10), 10);
  assert.equal(pairsPaidFor(PAIR_LISTING_USD * 10 - PAIR_LISTING_USD * 0.01), 10);
  // Short by a real margin buys fewer pairs rather than rounding up to what was asked for.
  assert.equal(pairsPaidFor(PAIR_LISTING_USD * 9.5), 9);
  assert.equal(pairsPaidFor(-5), 0);
});

test("the quote asks for slightly more than the strict price, and says so in COOK", () => {
  const q = listingQuote(10, 0.0001);

  assert.equal(q.usd, 10 * PAIR_LISTING_USD);
  assert.ok(q.cook != null && q.cook > q.usd / 0.0001, "a quote has to survive COOK moving");
  assert.ok(pairsPaidFor(q.cook! * 0.0001) >= 10, "and still buy what it quoted");
  assert.equal(listingQuote(3, null).cook, null, "no price, no quote");
});
