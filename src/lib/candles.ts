/**
 * Chart data for a Coorwa pair.
 *
 * A TOKEN/NVDA chart is the ratio of two independently sourced USD series:
 *
 *   - the Cookie Chain leg, rebuilt from real executed trades (Candy Shop's trade feed carries
 *     `price_usd` and a timestamp per fill, so candles are aggregated from actual fills rather than
 *     from a pool's standing quote);
 *   - the RWA leg, Jupiter's USD candles for the xStock.
 *
 * Dividing them bucket by bucket gives a real ratio series: how many shares of the stock one token
 * bought, over time. That is the number the whole product exists to show, and it is honest -
 * nothing here is synthesised or back-filled from a current price.
 */
import { CANDYSHOP_API } from "./config";
import { fetchJson, cachedStale } from "./http";

export type Interval = "5m" | "15m" | "1h" | "4h" | "1d";

const INTERVAL_SECONDS: Record<Interval, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
};

/** Jupiter's datapi spells intervals out. */
const JUP_INTERVAL: Record<Interval, string> = {
  "5m": "5_MINUTE",
  "15m": "15_MINUTE",
  "1h": "1_HOUR",
  "4h": "4_HOUR",
  "1d": "1_DAY",
};

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  id: number;
  mint: string;
  ts: number;
  price: number;
  price_usd: number;
  base_amount: number;
  quote_amount: number;
  side: "buy" | "sell";
  tx: string;
  maker: string;
  pool: string;
  venue: string;
  value_usd: number;
}

// --- Cookie Chain leg ----------------------------------------------------------------------------

export async function fetchTrades(mint: string, limit = 500): Promise<Trade[]> {
  return cachedStale(`trades:${mint}:${limit}`, 15_000, async () => {
    const rows = await fetchJson<Trade[]>(
      `${CANDYSHOP_API}/trades?mint=${encodeURIComponent(mint)}&limit=${limit}`,
      { timeoutMs: 20_000 },
    );
    return Array.isArray(rows) ? rows : [];
  });
}

/** Aggregate executed fills into OHLCV buckets. Volume is USD value traded. */
export function tradesToCandles(trades: Trade[], interval: Interval): Candle[] {
  const step = INTERVAL_SECONDS[interval];
  const buckets = new Map<number, Candle>();

  // The feed is newest-first; candles must be built in chronological order.
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);

  for (const t of sorted) {
    const price = t.price_usd;
    if (!Number.isFinite(price) || price <= 0) continue;
    const time = Math.floor(t.ts / step) * step;
    const b = buckets.get(time);
    if (!b) {
      buckets.set(time, {
        time,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: t.value_usd ?? 0,
      });
    } else {
      b.high = Math.max(b.high, price);
      b.low = Math.min(b.low, price);
      b.close = price;
      b.volume += t.value_usd ?? 0;
    }
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

// --- RWA leg ---------------------------------------------------------------------------------------

export async function fetchRwaCandles(
  mint: string,
  interval: Interval,
  count = 200,
): Promise<Candle[]> {
  return cachedStale(`rwacandles:${mint}:${interval}:${count}`, 60_000, async () => {
    const to = new Date().toISOString();
    const url =
      `https://datapi.jup.ag/v2/charts/${mint}` +
      `?interval=${JUP_INTERVAL[interval]}&to=${encodeURIComponent(to)}&candles=${count}&type=price`;
    const body = await fetchJson<{ candles: Candle[] }>(url, { timeoutMs: 20_000 });
    return Array.isArray(body?.candles) ? body.candles : [];
  });
}

/**
 * A price series' close in force at a moment: the last candle that opened at or before it. A moment
 * older than the series takes the first candle's open, and with no series at all the fallback (the
 * current price) stands in, so an outage of the series shows today's rate rather than nothing.
 */
export function closeAt(candles: readonly Candle[], ts: number, fallback: number | null) {
  if (candles.length === 0) return fallback;
  if (ts < candles[0].time) return candles[0].open;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].time <= ts) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].close;
}

// --- The ratio -------------------------------------------------------------------------------------

/** The most buckets a ratio chart returns. Enough for any interval, small enough to draw. */
const MAX_RATIO_CANDLES = 500;

/**
 * Divide the token series by the RWA series, one bucket at a time, from the first bucket both
 * series cover up to now.
 *
 * The token series is sparse (thin pools trade rarely), and charting only the buckets that traded
 * left a handful of disconnected boxes with days squeezed between them. So every bucket is emitted:
 *
 *   - the token's USD price carries forward from its last fill, because with no trade it did not move;
 *   - the RWA close carries forward the same way across market hours with no candle;
 *   - each candle opens where the previous one closed, so the series is one continuous line.
 *
 * A bucket with no fills still moves when the stock does, which is the honest reading of the pair.
 * Its volume is 0. Buckets before the RWA series starts are dropped rather than guessed.
 */
export function ratioCandles(
  token: Candle[],
  rwa: Candle[],
  step: number,
  nowSec = Math.floor(Date.now() / 1000),
): Candle[] {
  if (token.length === 0 || rwa.length === 0) return [];

  const sortedToken = [...token].sort((a, b) => a.time - b.time);
  const sortedRwa = [...rwa].filter((r) => r.close > 0).sort((a, b) => a.time - b.time);
  if (sortedRwa.length === 0) return [];

  const last = Math.floor(nowSec / step) * step;
  const first = Math.max(
    sortedToken[0].time,
    Math.ceil(sortedRwa[0].time / step) * step,
    last - (MAX_RATIO_CANDLES - 1) * step,
  );

  const out: Candle[] = [];
  let ti = 0;
  let ri = 0;
  let tokenClose: number | null = null;
  let prevRatio: number | null = null;

  for (let time = first; time <= last; time += step) {
    // Fills from buckets skipped by the cap still set where the token stood.
    while (ti < sortedToken.length && sortedToken[ti].time < time) {
      tokenClose = sortedToken[ti].close;
      ti++;
    }
    while (ri + 1 < sortedRwa.length && sortedRwa[ri + 1].time <= time) ri++;
    const r = sortedRwa[ri];
    if (r.time > time) continue;

    const bucket = sortedToken[ti]?.time === time ? sortedToken[ti] : null;
    if (bucket) ti++;
    if (!bucket && tokenClose == null) continue;

    // The RWA's own high/low would add noise that is not the pair's move, so the ratio's extremes
    // come from the token's extremes against the RWA's close for that bucket.
    const close = (bucket ? bucket.close : tokenClose!) / r.close;
    const open = prevRatio ?? (bucket ? bucket.open : tokenClose!) / r.close;
    const high = Math.max(open, close, bucket ? bucket.high / r.close : close);
    const low = Math.min(open, close, bucket ? bucket.low / r.close : close);

    out.push({ time, open, high, low, close, volume: bucket?.volume ?? 0 });
    if (bucket) tokenClose = bucket.close;
    prevRatio = close;
  }

  return out;
}

export { INTERVAL_SECONDS };
