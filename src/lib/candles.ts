/**
 * Chart data for a Corwa pair.
 *
 * A TOKEN/NVDA chart is the ratio of two independently sourced USD series:
 *
 *   - the Cookie Chain leg, rebuilt from real executed trades (Candy Shop's trade feed carries
 *     `price_usd` and a timestamp per fill, so candles are aggregated from actual fills rather than
 *     from a pool's standing quote);
 *   - the RWA leg, Jupiter's USD candles for the xStock.
 *
 * Dividing them bucket by bucket gives a real ratio series: how many shares of the stock one token
 * bought, over time. That is the number the whole product exists to show, and it is honest —
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

// --- The ratio -------------------------------------------------------------------------------------

/**
 * Divide the token series by the RWA series, bucket by bucket.
 *
 * The RWA series is dense and regular; the token series is sparse (thin pools trade rarely). So the
 * token drives the output and the RWA is forward-filled onto it: for each token candle we use the
 * most recent RWA close at or before that bucket. Buckets with no RWA price yet are dropped rather
 * than guessed.
 */
export function ratioCandles(token: Candle[], rwa: Candle[]): Candle[] {
  if (token.length === 0 || rwa.length === 0) return [];

  const sortedRwa = [...rwa].sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  let cursor = 0;

  for (const c of token) {
    while (cursor + 1 < sortedRwa.length && sortedRwa[cursor + 1].time <= c.time) cursor++;
    const r = sortedRwa[cursor];
    if (!r || r.time > c.time || !(r.close > 0)) continue;

    // The RWA's own high/low would add noise that is not the pair's move, so the ratio's extremes
    // come from the token's extremes against the RWA's close for that bucket.
    out.push({
      time: c.time,
      open: c.open / r.open || c.open / r.close,
      high: c.high / r.close,
      low: c.low / r.close,
      close: c.close / r.close,
      volume: c.volume,
    });
  }

  return out;
}

export { INTERVAL_SECONDS };
