"use client";

/**
 * The pair chart: a Cookie Chain token priced in shares of a real-world asset.
 *
 * The values are tiny by nature (a memecoin costs ~1e-8 of an NVDA share), so the price scale gets
 * a custom formatter - the default would render every level as 0.00.
 */
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import type { Candle, Interval } from "@/lib/candles";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { pct, tinyNumber } from "@/lib/format";

const INTERVALS: Interval[] = ["5m", "15m", "1h", "4h", "1d"];

/** A figure in the row above the chart. */
export interface ChartStat {
  label: string;
  value: string;
  tone?: "up" | "down";
}

/** The big number under that row: what the token is worth in the stock. */
export interface ChartHeadline {
  value: string;
  unit?: string;
  /** Percent. */
  change?: number | null;
  changeLabel?: string;
}

/** The logo's amber, for the line and the fill under it. */
const LINE = { line: "#e8a850", top: "rgba(240,184,96,0.32)", bottom: "rgba(240,184,96,0.02)" };

/*
 * The chart draws on a canvas, which cannot read CSS custom properties, so its chrome is written
 * out per theme here. The values are the text and divider tokens from globals.css.
 */
const CHART_THEME: Record<Theme, { text: string; grid: string; crosshair: string; label: string }> =
  {
    light: {
      text: "rgba(29,20,8,0.45)",
      grid: "rgba(29,20,8,0.05)",
      crosshair: "rgba(29,20,8,0.2)",
      label: "#3a1e0b",
    },
    dark: {
      text: "rgba(247,242,233,0.42)",
      grid: "rgba(247,242,233,0.05)",
      crosshair: "rgba(247,242,233,0.2)",
      label: "#251f18",
    },
  };

// Untrimmed, so every level on the price scale has the same width and the labels line up.
const formatRatio = (v: number) => tinyNumber(v, 4, false);

/** How many of the most recent candles are in view when a pair or interval is opened. */
const VISIBLE_CANDLES = 120;

export function RatioChart({
  mint,
  ticker,
  baseSymbol,
  pool,
  venue,
  stats = [],
  headline,
}: {
  mint: string;
  ticker: string;
  baseSymbol: string;
  /** A curve to chart, for a token whose fills are not in the pool feed yet. */
  pool?: string;
  /** Which curve that is: the launchpad indexes its own, Coorwa reads its program's events. */
  venue?: "momoswap" | "coorwa";
  stats?: ChartStat[];
  headline?: ChartHeadline;
}) {
  const theme = useTheme();
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<ISeriesApi<"Area"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [interval, setInterval] = useState<Interval>("1h");
  const [mode, setMode] = useState<"line" | "candles">("line");
  /**
   * What was loaded, and which request it answers. "Loading" is then a comparison against what is
   * being asked for now, rather than a flag written from inside the effect.
   */
  const [loaded, setLoaded] = useState<{
    key: string;
    error: string | null;
    count: number;
    trades: number;
  } | null>(null);

  const key = `${mint}|${ticker}|${interval}`;
  const loading = loaded?.key !== key;
  const error = loaded?.key === key ? loaded.error : null;
  const count = loaded?.key === key ? loaded.count : 0;
  const trades = loaded?.key === key ? loaded.trades : 0;

  useEffect(() => {
    if (!holder.current) return;

    // Colours are left out here: the theme effect below runs straight after this one, in the same
    // commit, and applies them before the first paint.
    const chart = createChart(holder.current, {
      layout: {
        background: { color: "transparent" },
        fontFamily: "var(--font-inter), system-ui, sans-serif",
        fontSize: 12,
        attributionLogo: false,
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.26 },
      },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { priceFormatter: formatRatio },
      autoSize: true,
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#34c759",
      downColor: "#ff3b30",
      wickUpColor: "rgba(52,199,89,0.6)",
      wickDownColor: "rgba(255,59,48,0.6)",
      borderVisible: false,
      priceFormat: { type: "custom", formatter: formatRatio, minMove: 1e-12 },
      visible: false,
    });

    const line = chart.addSeries(AreaSeries, {
      lineColor: LINE.line,
      topColor: LINE.top,
      bottomColor: LINE.bottom,
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: formatRatio, minMove: 1e-12 },
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      // The volume series shares the pane but not the axis: without this it stamps its own
      // last-value badge over the price scale.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.84, bottom: 0 },
      visible: false,
    });

    chartRef.current = chart;
    candleRef.current = candles;
    lineRef.current = line;
    volRef.current = volume;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      volRef.current = null;
    };
  }, []);

  // Both series hold the same data; the switch only shows one. Volume goes with the candles.
  useEffect(() => {
    candleRef.current?.applyOptions({ visible: mode === "candles" });
    volRef.current?.applyOptions({ visible: mode === "candles" });
    lineRef.current?.applyOptions({ visible: mode === "line" });
  }, [mode]);

  useEffect(() => {
    const c = CHART_THEME[theme];
    chartRef.current?.applyOptions({
      layout: { textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: {
        vertLine: { color: c.crosshair, labelBackgroundColor: c.label },
        horzLine: { color: c.crosshair, labelBackgroundColor: c.label },
      },
    });
  }, [theme]);

  useEffect(() => {
    let alive = true;
    let framed: string | null = null;

    const load = async () => {
      try {
        const res = await fetch(
          `/api/candles?mint=${mint}&ticker=${ticker}&interval=${interval}&mode=ratio` +
            (pool ? `&pool=${pool}` : "") +
            (venue ? `&venue=${venue}` : ""),
        );
        const json = (await res.json()) as {
          candles?: Candle[];
          tradeCount?: number;
          error?: string;
        };
        if (!alive) return;
        if (json.error) {
          setLoaded({ key, error: json.error, count: 0, trades: 0 });
          return;
        }
        const data = json.candles ?? [];
        candleRef.current?.setData(
          data.map((c) => ({
            time: c.time as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        );
        lineRef.current?.setData(data.map((c) => ({ time: c.time as Time, value: c.close })));
        volRef.current?.setData(
          data.map((c) => ({
            time: c.time as Time,
            value: c.volume,
            color: c.close >= c.open ? "rgba(52,199,89,0.28)" : "rgba(255,59,48,0.28)",
          })),
        );
        // Framed once per pair and interval. Doing it on every 30 s refresh threw away whatever the
        // user had scrolled or zoomed to.
        if (framed !== key && data.length > 0) {
          const scale = chartRef.current?.timeScale();
          if (data.length > VISIBLE_CANDLES) {
            scale?.setVisibleLogicalRange({ from: data.length - VISIBLE_CANDLES, to: data.length });
          } else {
            scale?.fitContent();
          }
          framed = key;
        }
        setLoaded({ key, error: null, count: data.length, trades: json.tradeCount ?? 0 });
      } catch (e) {
        if (alive) {
          setLoaded({
            key,
            error: e instanceof Error ? e.message : "chart failed to load",
            count: 0,
            trades: 0,
          });
        }
      }
    };

    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [mint, ticker, interval, key, pool, venue]);

  return (
    <div className="card flex w-full min-w-0 flex-col overflow-hidden p-4 sm:p-5">
      {stats.length > 0 && (
        <dl className="grid grid-cols-2 gap-y-4 sm:grid-cols-4">
          {stats.map((s, i) => (
            <div
              key={s.label}
              className={`min-w-0 border-[color:var(--divider)] px-3 ${i % 2 === 1 ? "border-l" : ""} ${
                i > 0 ? "sm:border-l" : ""
              }`}
            >
              <dt className="truncate text-[12px] text-subtle">{s.label}</dt>
              <dd
                className={`num mt-1 truncate text-[15px] ${
                  s.tone === "up"
                    ? "text-[color:var(--color-up)]"
                    : s.tone === "down"
                      ? "text-[color:var(--color-down)]"
                      : "text-primary"
                }`}
              >
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-5 flex flex-wrap items-end justify-between gap-3 px-1">
        {headline ? (
          <div className="min-w-0">
            <div className="num truncate text-[30px] font-medium leading-none tracking-[-0.03em] text-primary sm:text-[34px]">
              {headline.value}
              {headline.unit && <span className="text-[18px] text-subtle"> {headline.unit}</span>}
            </div>
            {headline.change != null && (
              <div
                className="num mt-1.5 text-[13px]"
                style={{ color: headline.change >= 0 ? "var(--color-up)" : "var(--color-down)" }}
              >
                {pct(headline.change)}{" "}
                {headline.changeLabel && <span className="text-subtle">{headline.changeLabel}</span>}
              </div>
            )}
          </div>
        ) : (
          <div className="text-[13px] text-muted">
            {baseSymbol} <span className="text-subtle">/</span> {ticker}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="segmented">
            <button onClick={() => setMode("line")} data-active={mode === "line"}>
              Line
            </button>
            <button onClick={() => setMode("candles")} data-active={mode === "candles"}>
              Candles
            </button>
          </div>
          <div className="segmented">
            {INTERVALS.map((i) => (
              <button
                key={i}
                onClick={() => setInterval(i)}
                data-active={i === interval}
                className="uppercase"
              >
                {i}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-raised relative mt-4 min-h-[340px] flex-1 overflow-hidden">
        <div ref={holder} className="absolute inset-0" />

        {loading && count === 0 && (
          <div className="absolute inset-0 grid place-items-center text-[13px] text-subtle">
            Loading fills
          </div>
        )}

        {!loading && error && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center text-[13px] text-[color:var(--color-down)]">
            {error}
          </div>
        )}

        {!loading && !error && count === 0 && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div className="max-w-sm">
              <div className="text-[15px] text-primary">No fills in this window</div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                This pool has not traded at the {interval} resolution. Try a wider interval - the
                chart is built from executed trades, so it shows nothing rather than inventing a
                line.
              </p>
            </div>
          </div>
        )}
      </div>

      {count > 0 && (
        <div className="mt-3 px-1 text-[12px] text-subtle">
          {count} candles from {trades} executed fills · ratio = USD({baseSymbol}) ÷
          USD({ticker}x)
        </div>
      )}
    </div>
  );
}
