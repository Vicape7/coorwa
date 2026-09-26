/**
 * The rent a graduation hands the curve's vault authority.
 *
 * The authority holds no data, so the chain lets it end a transaction with nothing or with at least
 * the rent-exempt minimum, and refuses anything in between. Sending too little fails the graduation;
 * sending too much leaves COOK in an address nobody can ever spend from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rentToSend } from "../src/lib/graduation-crank";

const rentMin = 890_880;

test("an empty authority gets exactly what the pool program takes, and ends empty", () => {
  assert.equal(rentToSend({ before: 0, used: 31_000_000, rentMin }), 31_000_000);
});

test("lamports already sitting there are used first", () => {
  assert.equal(rentToSend({ before: 10_000_000, used: 31_000_000, rentMin }), 21_000_000);
});

test("an authority left with less than the minimum is topped up to it, never left in between", () => {
  // 31.5M there, 31M used: half a million would remain, which the chain refuses.
  const sent = rentToSend({ before: 31_500_000, used: 31_000_000, rentMin });
  assert.equal(31_500_000 + sent - 31_000_000, rentMin);
  // Enough left over already: nothing to send.
  assert.equal(rentToSend({ before: 40_000_000, used: 31_000_000, rentMin }), 0);
});
