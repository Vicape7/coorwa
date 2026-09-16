/**
 * The pair chart's numbers: the ratio series has to be one continuous line, and a tiny price has to
 * print as something a person can read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ratioCandles, type Candle } from "../src/lib/candles";
import { tinyNumber } from "../src/lib/format";

const H = 3600;

const candle = (time: number, open: number, high: number, low: number, close: number, volume = 1) =>
  ({ time, open, high, low, close, volume }) satisfies Candle;

test("ratio candles fill the hours with no fills and connect open to the previous close", () => {
  const token = [candle(0, 10, 12, 9, 11, 5), candle(3 * H, 11, 14, 11, 13, 2)];
  const rwa = [candle(0, 100, 100, 100, 100), candle(2 * H, 200, 200, 200, 200)];

  const out = ratioCandles(token, rwa, H, 4 * H + 10);

  assert.deepEqual(
    out.map((c) => c.time),
    [0, H, 2 * H, 3 * H, 4 * H],
  );
  for (let i = 1; i < out.length; i++) assert.equal(out[i].open, out[i - 1].close);
  for (const c of out) {
    assert.ok(c.high >= Math.max(c.open, c.close));
    assert.ok(c.low <= Math.min(c.open, c.close));
  }
  // No fill, same stock price: flat, no volume.
  assert.deepEqual(out[1], { time: H, open: 0.11, high: 0.11, low: 0.11, close: 0.11, volume: 0 });
  // No fill, but the stock doubled, so the token is worth half as many shares.
  assert.equal(out[2].close, 11 / 200);
  assert.equal(out[3].close, 13 / 200);
  assert.equal(out[3].volume, 2);
});

test("ratio candles start where the stock series starts and keep the last token price", () => {
  const token = [candle(0, 10, 10, 10, 10)];
  const rwa = [candle(2 * H, 50, 50, 50, 50)];

  const out = ratioCandles(token, rwa, H, 3 * H);

  assert.deepEqual(
    out.map((c) => [c.time, c.close]),
    [
      [2 * H, 0.2],
      [3 * H, 0.2],
    ],
  );
});

test("tiny numbers print with a subscript zero count", () => {
  assert.equal(tinyNumber(4.3021e-9), "0.0₈4302");
  assert.equal(tinyNumber(4.3e-9), "0.0₈43");
  assert.equal(tinyNumber(4.3e-9, 4, false), "0.0₈4300");
  assert.equal(tinyNumber(9.99996e-9), "0.0₇1");
  assert.equal(tinyNumber(1.5e-12), "0.0₁₁15");
  assert.equal(tinyNumber(0.0123), "0.0123");
});
