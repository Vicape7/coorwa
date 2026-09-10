/**
 * Which assets a token may be quoted against.
 *
 * This is the one rule that separates a token launched through Corwa from a token that merely
 * exists on Cookie Chain, and getting it wrong is quiet rather than loud: too loose and a creator's
 * chosen benchmark stops meaning anything, too tight and a token disappears from the terminal. The
 * narrowing case is the one worth pinning, because that is what makes `findPair` refuse a slug
 * naming an asset the creator did not pick.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { quotesFor } from "../src/lib/pairs";

const ALL = [{ ticker: "SPY" }, { ticker: "NVDA" }, { ticker: "TSLA" }] as const;

test("a token nobody pinned stays quotable against everything asked for", () => {
  assert.deepEqual(quotesFor(undefined, ALL), ALL);
  assert.deepEqual(quotesFor(undefined, [ALL[1]]), [ALL[1]]);
});

test("a pinned token appears against its own asset and no other", () => {
  assert.deepEqual(quotesFor("TSLA", ALL), [{ ticker: "TSLA" }]);
});

test("asking a pinned token for an asset it is not pinned to comes back empty", () => {
  // The fallback to be avoided: this must not quietly answer with the whole list, or a slug like
  // "token-nvda" would resolve for a token its creator benchmarked against Tesla.
  assert.deepEqual(quotesFor("TSLA", [{ ticker: "NVDA" }]), []);
  assert.deepEqual(quotesFor("TSLA", []), []);
});

test("a pin naming an asset that is not on offer yields nothing rather than everything", () => {
  assert.deepEqual(quotesFor("GONE", ALL), []);
});
