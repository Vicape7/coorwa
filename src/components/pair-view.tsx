"use client";

import Link from "next/link";
import useSWR from "swr";
import { RatioChart } from "./ratio-chart";
import { SwapPanel } from "./swap-panel";
import { RecentTrades } from "./recent-trades";
import { TokenMark } from "./token-mark";
import { usd, amount, rwaRatio, pct, shortAddr } from "@/lib/format";
import {
  CASHBACK_SPLIT,
  COOKIE_EXPLORER,
  HOLDER_MIN_USD,
  cookieAccountUrl,
} from "@/lib/config";
import type { CoorwaPair } from "@/lib/pairs";
import type { RewardPool } from "@/lib/rewards-ledger";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function PairView({ initial }: { initial: CoorwaPair }) {
  const { data } = useSWR<CoorwaPair>(`/api/pair/${initial.slug}`, fetcher, {
    refreshInterval: 15_000,
    fallbackData: initial,
    keepPreviousData: true,
  });
  const pair = data ?? initial;

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-6">
      <Link
        href="/terminal"
        className="text-[13px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
      >
        &larr; All pairs
      </Link>

      {/* Header */}
      <div className="mt-4 flex flex-col gap-5 xl:flex-row xl:items-center xl:gap-8">
        <div className="flex shrink-0 items-center gap-3.5">
          <TokenMark logo={pair.base.logo} symbol={pair.base.symbol} size={52} />
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

        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
          <Metric
            label="Price"
            value={rwaRatio(pair.price)}
            sub={`${pair.quote.ticker} per token`}
          />
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
      </div>

      {/*
       * Body. On a phone both columns dissolve into one list (`contents`) and `order` puts the swap
       * panel right under the chart, instead of after every recent fill.
       */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_396px]">
        <div className="contents lg:flex lg:min-h-[460px] lg:flex-col lg:gap-4">
          {/*
            Every block is wrapped so it is the grid item itself: under `contents` the wrappers'
            children join the grid directly, and a grid item without min-w-0 grows to its widest
            row, which on a narrow phone pushed the chart's interval buttons past the screen. From lg
            the wrappers are `contents` again, so the desktop columns lay out exactly as before.
          */}
          <div className="min-w-0 lg:contents">
            <RatioChart
              mint={pair.base.mint}
              ticker={pair.quote.ticker}
              baseSymbol={pair.base.symbol}
            />
          </div>
          <div className="order-3 min-w-0 lg:contents">
            <RecentTrades
              mint={pair.base.mint}
              baseSymbol={pair.base.symbol}
              rwaPriceUsd={pair.quote.priceUsd}
              ticker={pair.quote.ticker}
            />
          </div>
        </div>

        <div className="contents lg:block lg:space-y-4">
          <div className="order-2 min-w-0 lg:contents">
            <SwapPanel pair={pair} />
          </div>

          <div className="order-4 min-w-0 lg:contents">
            <HolderRewards pair={pair} />
          </div>

          <div className="order-5 min-w-0 lg:contents">
            <PairFacts pair={pair} />
          </div>
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
    <div className="glass-pane min-w-0 rounded-[var(--radius-float)] px-4 py-3.5">
      <div className="label truncate">{label}</div>
      <div className={`num mt-1.5 truncate text-[19px] ${toneClass}`}>{value}</div>
      {sub && <div className={`mt-0.5 truncate text-[12px] ${subClass}`}>{sub}</div>}
    </div>
  );
}

/**
 * What holding this token pays, in its pair's stock. The reason a pair exists at all, so it sits
 * right under the swap.
 */
function HolderRewards({ pair }: { pair: CoorwaPair }) {
  const { data } = useSWR<{ configured: boolean; pool: RewardPool | null; nextRunAt: string | null }>(
    `/api/rewards/token?mint=${pair.base.mint}`,
    fetcher,
    { refreshInterval: 60_000 },
  );
  const pool = data?.pool ?? null;

  return (
    <div className="card p-5">
      <div className="label">Holder rewards</div>
      <p className="mt-2.5 text-[13px] leading-[1.7] text-muted">
        {Math.round(CASHBACK_SPLIT.holders * 100)}% of every fee Coorwa earns on {pair.base.symbol}{" "}
        is paid once a day to wallets holding at least {usd(HOLDER_MIN_USD)} of it, in{" "}
        {pair.quote.symbol} sent to the same address on Solana. Nothing to claim. The creator is
        paid {Math.round(CASHBACK_SPLIT.creator * 100)}% of the fees and is not counted as a holder.
      </p>
      <dl className="mt-4 space-y-2 border-t border-hair pt-4 text-[13px]">
        <Fact label="Paid to holders">
          <span className="num text-primary">{usd(pool?.holdersPaidUsd ?? 0)}</span>
        </Fact>
        <Fact label="Waiting to distribute">
          <span className="num text-primary">{usd(pool?.holdersWaitingUsd ?? 0)}</span>
        </Fact>
        <Fact label="Next run">
          <span className="num text-primary">
            {data?.nextRunAt ? new Date(data.nextRunAt).toLocaleString() : "after the next fee"}
          </span>
        </Fact>
      </dl>
      <Link
        href="/rewards"
        className="mt-4 inline-block text-[13px] text-muted underline underline-offset-4"
      >
        Your rewards
      </Link>
    </div>
  );
}

function PairFacts({ pair }: { pair: CoorwaPair }) {
  return (
    <div className="card p-5">
      <div className="label">How this pair is priced</div>
      <p className="mt-2.5 text-[13px] leading-[1.7] text-muted">
        {pair.base.symbol} trades in its {pair.venue ?? "Cookie Chain"} pool and is priced live in{" "}
        {pair.quote.ticker} shares: <span className="num text-primary">USD({pair.base.symbol})</span>{" "}
        &divide; <span className="num text-primary">USD({pair.quote.symbol})</span>, real reserves on
        Cookie Chain over real {pair.quote.symbol} liquidity on Solana. Nothing is modelled, so the
        number is exact.
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
