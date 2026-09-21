/**
 * Which asset a token is quoted against.
 *
 * A token has one pair, and that pair is the asset its holders are paid in. Getting this wrong is
 * quiet rather than loud: too loose and a slug nobody chose resolves to a market, too tight and a
 * token disappears. The narrowing case matters most, because that is what makes `findPair` refuse a
 * slug for a pair the creator never picked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { quotesFor, uniqueSlugs } from "../src/lib/pairs";

const ALL = [{ ticker: "NVDA" }, { ticker: "TSLA" }, { ticker: "SPY" }] as const;
const [nvda, tsla, spy] = ALL.map((a) => a.ticker);

test("a token nobody chose a pair for carries none", () => {
  assert.deepEqual(quotesFor(undefined, undefined, ALL), []);
});

test("a token carries exactly the one pair that was bought for it", () => {
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

test("two tokens with the same symbol and stock are both named by their mint", () => {
  const pair = (slug: string, mint: string, ticker = "NVDA") => ({
    slug,
    base: { mint },
    quote: { ticker },
  });
  const real = pair("cote-nvda", "BDEFBNgzV5MzCnF4ccWNYbjy5g8wh5Y76T4xkWn1momo");
  const copy = pair("cote-nvda", "CopyCopyCopyCopyCopyCopyCopyCopyCopyCopy1111");
  const chat = pair("chat-nvda", "2wPK38gv8dWU89K5zDAAULAihnU1sRocbpzwPP6twY7Q");
  const cote = pair("cote-tsla", "Cote2Cote2Cote2Cote2Cote2Cote2Cote2Cote2Cot1", "TSLA");

  const slugs = uniqueSlugs([copy, real, chat, cote]).map((p) => p.slug);

  assert.deepEqual(slugs, [
    "CopyCopyCopyCopyCopyCopyCopyCopyCopyCopy1111-nvda",
    "BDEFBNgzV5MzCnF4ccWNYbjy5g8wh5Y76T4xkWn1momo-nvda",
    "chat-nvda",
    "cote-tsla",
  ]);
  assert.equal(new Set(slugs).size, slugs.length, "no slug opens two pairs");
});
