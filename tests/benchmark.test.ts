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
import { billableTickers, pairsPaidFor, listingQuote, FREE_TICKER } from "../src/lib/listings";
import { PAIR_LISTING_USD } from "../src/lib/config";

const ALL = [{ ticker: FREE_TICKER }, { ticker: "TSLA" }, { ticker: "SPY" }] as const;
const other = ALL.filter((a) => a.ticker !== FREE_TICKER).map((a) => a.ticker);

test("a token nobody chose or paid for carries exactly one benchmark", () => {
  assert.deepEqual(quotesFor(undefined, undefined, ALL), [{ ticker: FREE_TICKER }]);
  assert.deepEqual(quotesFor(undefined, [], ALL), [{ ticker: FREE_TICKER }]);
});

test("a paid pair is carried alongside the free one, never instead of it", () => {
  const carried = quotesFor(undefined, [other[0]], ALL).map((a) => a.ticker);

  assert.ok(carried.includes(FREE_TICKER), "paying must not cost a token its free benchmark");
  assert.ok(carried.includes(other[0]));
  assert.equal(carried.length, 2);
});

test("a token launched here appears against its own benchmark and no other", () => {
  assert.deepEqual(quotesFor(other[0], undefined, ALL), [{ ticker: other[0] }]);
  // Even paid listings do not widen it: the creator chose, and that choice is the whole point.
  assert.deepEqual(quotesFor(other[0], [other[1]], ALL), [{ ticker: other[0] }]);
});

test("asking for an asset a token does not carry comes back empty", () => {
  // The fallback to be avoided: answering with the full set would resolve slugs nobody chose.
  assert.deepEqual(quotesFor(undefined, undefined, [{ ticker: other[0] }]), []);
  assert.deepEqual(quotesFor(other[0], undefined, [{ ticker: other[1] }]), []);
  assert.deepEqual(quotesFor("GONE", undefined, ALL), []);
});

test("nobody is charged for a pair they already have", () => {
  assert.deepEqual(billableTickers([FREE_TICKER], []), [], "the free one is never billable");
  assert.deepEqual(billableTickers([other[0]], [other[0]]), [], "already listed, already paid");
  assert.deepEqual(billableTickers([other[0], other[1]], [other[0]]), [other[1]]);
});

test("a repeated or unknown ticker cannot inflate the bill", () => {
  assert.deepEqual(billableTickers([other[0], other[0], other[0]], []), [other[0]]);
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
