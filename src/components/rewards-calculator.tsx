"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  CASHBACK_RWA_MIN_USD,
  CASHBACK_SPLIT,
  COORWA_SWAP_FEE_BPS,
  MOMOSWAP_REFERRAL_SHARE,
  MOMOSWAP_TRADE_FEE_BPS,
  PAIR_LISTING_USD,
} from "@/lib/config";
import { RWA_ASSETS } from "@/lib/rwa";
import { PillSelect } from "./ui/pill-select";
import { GlassEffect } from "./ui/liquid-glass";
import { SlidingNumber } from "./ui/sliding-number";

/**
 * "What would I get?" on the landing page: sliders for how much a token trades through Coorwa and
 * how much of it you hold, and the split that follows, in dollars and in the stock you would take.
 *
 * Every rate comes from config, the same constants the epochs are computed with, so the page cannot
 * drift from what is actually paid. It is an estimate by construction: a real epoch pays on the
 * volume that happened and on sampled balances, not on a flat share.
 */

const VENUES = {
  launchpad: {
    label: "Launchpad curve",
    // MomoSwap's referral share of its own curve fee. Costs the trader nothing extra.
    bps: MOMOSWAP_TRADE_FEE_BPS * MOMOSWAP_REFERRAL_SHARE,
  },
  terminal: {
    label: "Terminal swap",
    bps: COORWA_SWAP_FEE_BPS,
  },
} as const;

type Venue = keyof typeof VENUES;

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function RewardsCalculator() {
  const [venue, setVenue] = useState<Venue>("launchpad");
  const [volume, setVolume] = useState(2_000);
  const [days, setDays] = useState(30);
  const [share, setShare] = useState(5);
  const [pairs, setPairs] = useState(1);
  const [ticker, setTicker] = useState("NVDA");

  const { data } = useSWR<{ prices: Record<string, number> }>("/api/rwa/prices", fetcher, {
    revalidateOnFocus: false,
  });
  const price = data?.prices?.[ticker];

  const fees = (volume * days * VENUES[venue].bps) / 10_000;
  const holders = fees * CASHBACK_SPLIT.holders + pairs * PAIR_LISTING_USD;
  const creator = fees * CASHBACK_SPLIT.creator;
  const you = (holders * share) / 100;

  return (
    <GlassEffect refract="deep" className="rounded-[var(--radius-float)] p-6 sm:p-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="label text-[12px]">Rewards calculator</span>
          <h2 className="display mt-3 text-[clamp(1.75rem,3.4vw,2.4rem)] text-primary">
            Hold a token, get paid in its stock.
          </h2>
        </div>
        <div className="segmented" role="group" aria-label="Where the token trades">
          {(Object.keys(VENUES) as Venue[]).map((v) => (
            <button
              key={v}
              type="button"
              data-active={venue === v}
              onClick={() => setVenue(v)}
            >
              {VENUES[v].label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-9 grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:gap-12">
        <div className="flex flex-col gap-7">
          <Slider
            id="calc-volume"
            label="Traded through Coorwa, per day"
            display={`$${volume.toLocaleString("en-US")}`}
            scale={logScale(100, 250_000, niceRound)}
            value={volume}
            onChange={setVolume}
          />
          <Slider
            id="calc-days"
            label="Days held"
            display={`${days} ${days === 1 ? "day" : "days"}`}
            scale={linearScale(1, 90)}
            value={days}
            onChange={setDays}
          />
          <Slider
            id="calc-share"
            label="Your share of what holders hold"
            display={`${share}%`}
            scale={logScale(0.1, 50, (n) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n)))}
            value={share}
            onChange={setShare}
          />
          <Slider
            id="calc-pairs"
            label="Pairs listed on the token"
            display={`${pairs} × $${PAIR_LISTING_USD}`}
            scale={linearScale(0, RWA_ASSETS.length)}
            value={pairs}
            onChange={setPairs}
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className="nav-well rounded-[var(--radius-card)] p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="label">You would get</span>
              <PillSelect
                id="calc-stock"
                label="Paid out as"
                prefix="as"
                value={ticker}
                onChange={setTicker}
                options={RWA_ASSETS.map((a) => ({ value: a.ticker, label: a.symbol }))}
              />
            </div>
            <SlidingNumber
              value={money(you)}
              className="num display mt-4 block text-[clamp(2.6rem,6vw,3.75rem)] text-primary"
            />
            <div className="num mt-2 text-[15px] text-muted">
              <StockAmount usd={you} price={price} symbol={`${ticker}x`} />
            </div>
            {you < CASHBACK_RWA_MIN_USD && (
              <p className="mt-3 text-[13px] text-subtle">
                Under ${CASHBACK_RWA_MIN_USD} it pays out in COOK instead; stock payouts start at $
                {CASHBACK_RWA_MIN_USD}.
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Tile
              who="All holders"
              pct={CASHBACK_SPLIT.holders}
              usd={holders}
              price={price}
              ticker={ticker}
            />
            <Tile
              who="Creator"
              pct={CASHBACK_SPLIT.creator}
              usd={creator}
              price={price}
              ticker={ticker}
            />
          </div>

          <p className="num px-1 pt-1 text-[13px] leading-[1.6] text-subtle">
            {money(fees)} in fees over {days} {days === 1 ? "day" : "days"} at{" "}
            {(VENUES[venue].bps / 100).toFixed(2)}%
            {pairs > 0 && <>, plus {money(pairs * PAIR_LISTING_USD)} from listings to holders</>}.
          </p>
        </div>
      </div>
    </GlassEffect>
  );
}

function Tile({
  who,
  pct,
  usd,
  price,
  ticker,
}: {
  who: string;
  pct: number;
  usd: number;
  price: number | undefined;
  ticker: string;
}) {
  return (
    <div className="nav-well rounded-[var(--radius-card)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[14px] font-medium text-primary">{who}</span>
        <span className="num text-[13px] text-subtle">{(pct * 100).toFixed(1)}%</span>
      </div>
      <SlidingNumber value={money(usd)} className="num mt-2 block text-[26px] text-primary" />
      <div className="num mt-1 text-[13px] text-muted">
        <StockAmount usd={usd} price={price} symbol={`${ticker}x`} />
      </div>
    </div>
  );
}

function StockAmount({
  usd,
  price,
  symbol,
}: {
  usd: number;
  price: number | undefined;
  symbol: string;
}) {
  if (!price) return <span className="skeleton inline-block h-4 w-24 align-middle" />;
  const shares = usd / price;
  return (
    <>
      &asymp; {shares.toFixed(shares >= 10 ? 2 : shares >= 1 ? 3 : 4)} {symbol}
    </>
  );
}

// --- Sliders ---------------------------------------------------------------------------------------

/** Maps a slider's 0..1000 track to a value and back. */
interface Scale {
  toValue: (pos: number) => number;
  toPos: (value: number) => number;
}

const STEPS = 1000;

function linearScale(min: number, max: number): Scale {
  return {
    toValue: (p) => Math.round(min + ((max - min) * p) / STEPS),
    toPos: (v) => ((v - min) / (max - min)) * STEPS,
  };
}

/** Volume and holding share both span three orders of magnitude, so the track is logarithmic. */
function logScale(min: number, max: number, round: (n: number) => number): Scale {
  const span = Math.log(max / min);
  return {
    toValue: (p) => round(min * Math.exp((span * p) / STEPS)),
    toPos: (v) => (Math.log(v / min) / span) * STEPS,
  };
}

/** Two significant figures: 1,200 rather than 1,187. */
function niceRound(n: number): number {
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

function Slider({
  id,
  label,
  display,
  scale,
  value,
  onChange,
}: {
  id: string;
  label: string;
  display: string;
  scale: Scale;
  value: number;
  onChange: (v: number) => void;
}) {
  const pos = Math.min(STEPS, Math.max(0, scale.toPos(value)));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <span className="num text-[15px] font-medium text-primary">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={pos}
        aria-valuetext={display}
        onChange={(e) => onChange(scale.toValue(Number(e.target.value)))}
        className="range mt-3 w-full"
        style={{ "--fill": `${(pos / STEPS) * 100}%` } as React.CSSProperties}
      />
    </div>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
