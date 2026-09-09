"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { RatioChart } from "./ratio-chart";
import { SwapPanel } from "./swap-panel";
import { CrossChainPanel } from "./crosschain-panel";
import { RecentTrades } from "./recent-trades";
import { TokenMark } from "./token-mark";
import { usd, amount, rwaRatio, pct, shortAddr } from "@/lib/format";
import { cookieAccountUrl, COOKIE_EXPLORER } from "@/lib/config";
import type { CorwaPair } from "@/lib/pairs";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function PairView({ initial }: { initial: CorwaPair }) {
  const { data } = useSWR<CorwaPair>(`/api/pair/${initial.slug}`, fetcher, {
    refreshInterval: 15_000,
    fallbackData: initial,
    keepPreviousData: true,
  });
  const pair = data ?? initial;
  const [tab, setTab] = useState<"swap" | "cross">("swap");

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-6">
      <Link
        href="/terminal"
        className="text-[13px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
      >
        &larr; All pairs
      </Link>

      {/* Header */}
      <div className="mt-4 flex flex-wrap items-center gap-x-10 gap-y-5">
        <div className="flex items-center gap-3.5">
          <TokenMark logo={pair.base.logo} symbol={pair.base.symbol} size={44} />
          <div>
            <h1 className="display text-[34px] leading-none text-primary">
              {pair.base.symbol}
              <span className="text-subtle"> / </span>
              {pair.quote.ticker}
            </h1>
            <p className="mt-1.5 text-[13px] text-muted">
              {pair.base.name} priced in {pair.quote.name} shares
            </p>
          </div>
        </div>

        <Metric label="Price" value={rwaRatio(pair.price)} sub={`${pair.quote.ticker} per token`} />
        <Metric
          label={`1 ${pair.quote.ticker} buys`}
          value={amount(pair.inverse)}
          sub={pair.base.symbol}
        />
        <Metric
          label={`vs ${pair.quote.ticker} 24h`}
          value={pair.change24h == null ? "—" : pct(pair.change24h)}
          sub={pair.base.stale ? "no fills in 24h" : "relative return"}
          tone={pair.change24h == null ? undefined : pair.change24h >= 0 ? "up" : "down"}
        />
        <Metric label="Liquidity" value={usd(pair.base.liquidityUsd)} sub="across all pools" />
        <Metric
          label={`${pair.quote.symbol} spot`}
          value={`$${pair.quote.priceUsd.toFixed(2)}`}
          sub={pct(pair.quote.change24h)}
          subTone={(pair.quote.change24h ?? 0) >= 0 ? "up" : "down"}
        />
      </div>

      {/* Body */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_396px]">
        <div className="flex min-h-[460px] flex-col gap-4">
          <RatioChart
            mint={pair.base.mint}
            ticker={pair.quote.ticker}
            baseSymbol={pair.base.symbol}
          />
          <RecentTrades
            mint={pair.base.mint}
            baseSymbol={pair.base.symbol}
            rwaPriceUsd={pair.quote.priceUsd}
            ticker={pair.quote.ticker}
          />
        </div>

        <div className="space-y-4">
          <div className="segmented w-full">
            <button onClick={() => setTab("swap")} data-active={tab === "swap"} className="flex-1">
              Trade on Cookie
            </button>
            <button onClick={() => setTab("cross")} data-active={tab === "cross"} className="flex-1">
              Settle in {pair.quote.ticker}
            </button>
          </div>

          {tab === "swap" ? <SwapPanel pair={pair} /> : <CrossChainPanel pair={pair} />}

          <PairFacts pair={pair} />
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
  subTone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down";
  subTone?: "up" | "down";
}) {
  const toneClass =
    tone === "up"
      ? "text-[color:var(--color-up)]"
      : tone === "down"
        ? "text-[color:var(--color-down)]"
        : "text-primary";
  const subClass =
    subTone === "up"
      ? "text-[color:var(--color-up)]"
      : subTone === "down"
        ? "text-[color:var(--color-down)]"
        : "text-subtle";

  return (
    <div>
      <div className="label">{label}</div>
      <div className={`num mt-1 text-[19px] ${toneClass}`}>{value}</div>
      {sub && <div className={`mt-0.5 text-[12px] ${subClass}`}>{sub}</div>}
    </div>
  );
}

function PairFacts({ pair }: { pair: CorwaPair }) {
  return (
    <div className="card p-5">
      <div className="label">How this pair is priced</div>
      <p className="mt-2.5 text-[13px] leading-[1.7] text-muted">
        There is no {pair.base.symbol}/{pair.quote.ticker} pool anywhere, and Corwa does not pretend
        otherwise. The price is <span className="num text-primary">USD({pair.base.symbol})</span>{" "}
        &divide; <span className="num text-primary">USD({pair.quote.symbol})</span> — the first from
        real reserves in the {pair.venue ?? "Cookie Chain"} pool, the second from real Solana
        liquidity. Both are live market prices, so the ratio is a change of units, not a synthetic
        instrument.
      </p>

      <dl className="mt-4 space-y-2 border-t border-hair pt-4 text-[13px]">
        <Fact label="Base mint">
          <ExtLink href={cookieAccountUrl(pair.base.mint)}>{shortAddr(pair.base.mint, 6)}</ExtLink>
        </Fact>
        <Fact label="Deepest pool">
          {pair.poolId ? (
            <ExtLink href={`${COOKIE_EXPLORER}/account/${pair.poolId}`}>{pair.venue}</ExtLink>
          ) : (
            <span className="text-subtle">—</span>
          )}
        </Fact>
        <Fact label={`${pair.quote.symbol} mint`}>
          <ExtLink href={`https://solscan.io/token/${pair.quote.mint}`}>
            {shortAddr(pair.quote.mint, 6)}
          </ExtLink>
        </Fact>
        <Fact label="Holders">
          <span className="num text-primary">{pair.base.holders ?? "—"}</span>
        </Fact>
        <Fact label="Market cap">
          <span className="num text-primary">{usd(pair.base.marketCap)}</span>
        </Fact>
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="num text-primary underline decoration-[color:var(--divider-strong)] underline-offset-4 transition-colors hover:decoration-[color:var(--text-muted)]"
    >
      {children}
    </a>
  );
}
