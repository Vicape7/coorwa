/**
 * Which asset a token is quoted against, and what setting it costs.
 *
 * A token has one pair, and that pair is the asset its holders are paid in. Getting this wrong is
 * quiet rather than loud: too loose and a slug nobody chose resolves to a market, too tight and a
 * token disappears. The narrowing case matters most, because that is what makes `findPair` refuse a
 * slug for a pair the creator never picked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { quotesFor } from "../src/lib/pairs";
import { paymentCovers, listingQuote } from "../src/lib/listings";
import { PAIR_LISTING_USD } from "../src/lib/config";

const ALL = [{ ticker: "NVDA" }, { ticker: "TSLA" }, { ticker: "SPY" }] as const;
const [nvda, tsla, spy] = ALL.map((a) => a.ticker);

test("a token nobody chose a pair for carries none", () => {
  assert.deepEqual(quotesFor(undefined, undefined, ALL), []);
});

test("a token carries exactly the one pair its creator bought", () => {
  assert.deepEqual(quotesFor(undefined, tsla, ALL), [{ ticker: tsla }]);
});

test("the launch pick wins over any older bought pair", () => {
  assert.deepEqual(quotesFor(tsla, undefined, ALL), [{ ticker: tsla }]);
  assert.deepEqual(quotesFor(tsla, spy, ALL), [{ ticker: tsla }], "never two pairs");
});

test("asking for an asset a token does not carry comes back empty", () => {
  // The fallback to be avoided: answering with the full set would resolve slugs nobody chose.
  assert.deepEqual(quotesFor(undefined, tsla, [{ ticker: nvda }]), []);
  assert.deepEqual(quotesFor(tsla, undefined, [{ ticker: spy }]), []);
  assert.deepEqual(quotesFor("GONE", undefined, ALL), []);
});

test("a payment covers the pair, and a hair under the line still counts", () => {
  assert.equal(paymentCovers(0), false);
  assert.equal(paymentCovers(-5), false);
  assert.equal(paymentCovers(PAIR_LISTING_USD), true);
  assert.equal(paymentCovers(PAIR_LISTING_USD * 0.99), true);
  assert.equal(paymentCovers(PAIR_LISTING_USD * 0.9), false, "short by a real margin buys nothing");
});

test("the quote asks for slightly more than the strict price, and says so in COOK", () => {
  const q = listingQuote(0.0001);

  assert.equal(q.usd, PAIR_LISTING_USD);
  assert.ok(q.cook != null && q.cook > q.usd / 0.0001, "a quote has to survive COOK moving");
  assert.ok(paymentCovers(q.cook! * 0.0001), "and still cover what it quoted");
  assert.equal(listingQuote(null).cook, null, "no price, no quote");
});
