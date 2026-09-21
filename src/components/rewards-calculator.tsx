"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  PAYOUT_MIN_USD,
  COORWA_SWAP_FEE_BPS,
  MOMOSWAP_REFERRAL_SHARE,
  MOMOSWAP_TRADE_FEE_BPS,
  HOLDER_MIN_USD,
} from "@/lib/config";
import { RWA_ASSETS } from "@/lib/rwa";
import { PillSelect } from "./ui/pill-select";
import { GlassEffect } from "./ui/liquid-glass";
import { SlidingNumber } from "./ui/sliding-number";

/**
 * "What would I get?" on the landing page: sliders for how much a token trades through Coorwa, how
 * many wallets clear the $5 floor and how much of what they hold is yours, and the split that
 * follows, in dollars and in the stock you would take.
 *
 * Every rate comes from config, the same constants the daily payout runs on, so the page cannot
 * drift from what is actually paid. It is an estimate by construction: a real run pays on the
 * volume that happened and on sampled balances, not on a flat share.
 */

const VENUES = {
  terminal: {
    label: "Terminal swap",
    bps: COORWA_SWAP_FEE_BPS,
  },
  launchpad: {
    label: "Launchpad curve",
    // MomoSwap's referral share of its own curve fee. Costs the trader nothing extra.
    bps: MOMOSWAP_TRADE_FEE_BPS * MOMOSWAP_REFERRAL_SHARE,
  },
} as const;

type Venue = keyof typeof VENUES;

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function RewardsCalculator() {
  const [venue, setVenue] = useState<Venue>("terminal");
  const [volume, setVolume] = useState(10_000);
  const [days, setDays] = useState(30);
  const [wallets, setWallets] = useState(10);
  const [share, setShare] = useState(10);
  const [ticker, setTicker] = useState("NVDA");

  /*
   * A pool is shared out by what each wallet holds, never evenly, so the two holder sliders are
   * free of each other - except at the ends: one wallet over the floor takes the whole pool, and
   * anything less than the whole pool needs a second wallet to take the rest.
   */
  function pickWallets(n: number) {
    setWallets(n);
    if (n === 1) setShare(100);
  }
  function pickShare(pct: number) {
    setShare(pct);
    if (pct < 100 && wallets === 1) setWallets(2);
  }

  /*
   * The prices take a few seconds, sixteen quotes behind one route, and the calculator sits well
   * below the fold. They are asked for when it comes within a screen of view, not on every visit
   * to the landing page, so a visitor who never scrolls this far costs the Worker nothing.
   */
  const boxRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || near) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [near]);

  const { data } = useSWR<{ prices: Record<string, number> }>(
    near ? "/api/rwa/prices" : null,
    fetcher,
    { revalidateOnFocus: false },
  );
  const price = data?.prices?.[ticker];

  const fees = (volume * days * VENUES[venue].bps) / 10_000;
  // All of it goes back to the token's holders, its creator among them, by what each one holds.
  const holders = fees;
  const you = (holders * share) / 100;
  const eachOther = wallets > 1 ? (holders - you) / (wallets - 1) : 0;

  return (
    <div ref={boxRef}>
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
              id="calc-wallets"
              label={`Wallets holding over $${HOLDER_MIN_USD}`}
              display={`${wallets} ${wallets === 1 ? "wallet" : "wallets"}`}
              scale={linearScale(1, 20)}
              value={wallets}
              onChange={pickWallets}
            />
            <Slider
              id="calc-share"
              label="Your share of what they hold"
              display={`${share}%`}
              scale={linearScale(1, 100)}
              value={share}
              onChange={pickShare}
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
              {wallets > 1 && (
                <p className="num mt-3 text-[13px] text-subtle">
                  The other {wallets - 1} {wallets === 2 ? "wallet" : "wallets"} over $
                  {HOLDER_MIN_USD} share {money(holders - you)}, {money(eachOther)} each on average.
                </p>
              )}
              {you < PAYOUT_MIN_USD && (
                <p className="mt-3 text-[13px] text-subtle">
                  Under ${PAYOUT_MIN_USD} it waits and adds up over later days; each stock is sent
                  once it reaches ${PAYOUT_MIN_USD}.
                </p>
              )}
            </div>

            <Tile who="All holders, the creator among them" usd={holders} price={price} ticker={ticker} />

            <p className="num px-1 pt-1 text-[13px] leading-[1.6] text-subtle">
              {money(fees)} in fees over {days} {days === 1 ? "day" : "days"} at{" "}
              {(VENUES[venue].bps / 100).toFixed(2)}%. A wallet under ${HOLDER_MIN_USD} at the
              snapshot does not share the pool.
            </p>
          </div>
        </div>
      </GlassEffect>
    </div>
  );
}

function Tile({
  who,
  usd,
  price,
  ticker,
}: {
  who: string;
  usd: number;
  price: number | undefined;
  ticker: string;
}) {
  return (
    <div className="nav-well rounded-[var(--radius-card)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[14px] font-medium text-primary">{who}</span>
        <span className="num text-[13px] text-subtle">100%</span>
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

/** Volume spans three orders of magnitude, so its track is logarithmic; the rest are linear. */
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
