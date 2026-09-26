"use client";

import Link from "next/link";
import useSWR from "swr";
import { RatioChart } from "./ratio-chart";
import { SwapPanel } from "./swap-panel";
import { RecentTrades } from "./recent-trades";
import { GraduatedClaim } from "./graduated-claim";
import { ActivityCard, PairLayout, PanelIdentity, useRewardPool } from "./pair-layout";
import { usd, amount, rwaRatio, pct, shortAddr } from "@/lib/format";
import { HOLDER_MIN_USD, cookieAccountUrl } from "@/lib/config";
import type { CoorwaPair } from "@/lib/pairs";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function PairView({ initial }: { initial: CoorwaPair }) {
  const { data } = useSWR<CoorwaPair>(`/api/pair/${initial.slug}`, fetcher, {
    refreshInterval: 15_000,
    fallbackData: initial,
    keepPreviousData: true,
  });
  const pair = data ?? initial;
  const { pool } = useRewardPool(pair.base.mint);

  return (
    <PairLayout
      about={
        <>
          Every fee Coorwa earns on {pair.base.symbol} goes back to its holders, paid once a day in{" "}
          {pair.quote.symbol} on Solana. {pair.base.name} is priced live in {pair.quote.name}{" "}
          shares.
        </>
      }
      stats={[
        { label: "Paid to holders", value: usd(pool?.holdersPaidUsd ?? 0) },
        { label: "Waiting to distribute", value: usd(pool?.holdersWaitingUsd ?? 0) },
      ]}
      links={[
        { label: "Explorer", href: cookieAccountUrl(pair.base.mint), icon: "explorer" },
        { label: "Contract", copy: pair.base.mint, icon: "copy" },
        ...(pair.poolId
          ? [{ label: "Pool", href: cookieAccountUrl(pair.poolId), icon: "pool" as const }]
          : []),
        {
          label: pair.quote.symbol,
          href: `https://solscan.io/token/${pair.quote.mint}`,
          icon: "stock",
        },
      ]}
      panel={
        <>
          <GraduatedClaim mint={pair.base.mint} symbol={pair.base.symbol} />
          <SwapPanel
            pair={pair}
            header={
              <PanelIdentity
                logo={pair.base.logo}
                name={pair.base.name}
                symbol={pair.base.symbol}
                sub={`priced in ${pair.quote.ticker}`}
              />
            }
          />
        </>
      }
      chart={
        <RatioChart
          mint={pair.base.mint}
          ticker={pair.quote.ticker}
          baseSymbol={pair.base.symbol}
          stats={[
            { label: "Market cap", value: usd(pair.base.marketCap) },
            { label: "Liquidity", value: usd(pair.base.liquidityUsd) },
            { label: "24h volume", value: usd(pair.base.volume24h) },
            {
              label: `${pair.quote.symbol} share`,
              value: `$${pair.quote.priceUsd.toFixed(2)}`,
            },
          ]}
          headline={{
            value: rwaRatio(pair.price),
            unit: pair.quote.ticker,
            change: pair.change24h,
            changeLabel: pair.base.stale ? "no fills in 24h" : `vs ${pair.quote.ticker}, 24h`,
          }}
        />
      }
      activity={
        <ActivityCard
          fills={
            <RecentTrades
              mint={pair.base.mint}
              baseSymbol={pair.base.symbol}
              rwaPriceUsd={pair.quote.priceUsd}
              ticker={pair.quote.ticker}
            />
          }
          rewards={
            <HolderRewards
              mint={pair.base.mint}
              symbol={pair.base.symbol}
              stock={pair.quote.symbol}
            />
          }
          facts={<PairFacts pair={pair} />}
        />
      }
    />
  );
}

/**
 * What holding this token pays, in its pair's stock. The reason a pair exists at all. Drawn inside
 * the activity card, so it has no card of its own.
 */
export function HolderRewards({
  mint,
  symbol,
  stock,
  taxBps,
}: {
  mint: string;
  symbol: string;
  /** The xStock holders are paid in, e.g. "NVDAx". */
  stock: string;
  /** Set for a token launched on Coorwa's curve, whose holders are paid its transfer tax. */
  taxBps?: number;
}) {
  const { pool, nextRunAt } = useRewardPool(mint);

  return (
    <div className="grid gap-6 px-1 md:grid-cols-2 md:gap-10">
      <div>
        <p className="text-[13px] leading-[1.7] text-muted">
          {taxBps != null
            ? `The ${taxBps / 100}% tax on every ${symbol} transfer, wherever it trades,`
            : `Every fee Coorwa earns on ${symbol}`}{" "}
          is paid once a day to wallets holding at least {usd(HOLDER_MIN_USD)} of it, in {stock}{" "}
          sent to the same address on Solana. Nothing to claim. Its creator is paid the same way,
          for what they hold, and takes no share of their own.
        </p>
        <Link
          href="/rewards"
          className="mt-3 inline-block text-[13px] text-muted underline underline-offset-4"
        >
          Your rewards
        </Link>
      </div>
      <dl className="space-y-2.5 text-[13px]">
        <Fact label="Paid to holders">
          <span className="num text-primary">{usd(pool?.holdersPaidUsd ?? 0)}</span>
        </Fact>
        <Fact label="Waiting to distribute">
          <span className="num text-primary">{usd(pool?.holdersWaitingUsd ?? 0)}</span>
        </Fact>
        <Fact label="Next run">
          <span className="num text-primary">
            {nextRunAt ? new Date(nextRunAt).toLocaleString() : "after the next fee"}
          </span>
        </Fact>
      </dl>
    </div>
  );
}

function PairFacts({ pair }: { pair: CoorwaPair }) {
  return (
    <div className="grid gap-6 px-1 md:grid-cols-2 md:gap-10">
      <p className="text-[13px] leading-[1.7] text-muted">
        {pair.base.symbol} trades in its {pair.venue ?? "Cookie Chain"} pool and is priced live in{" "}
        {pair.quote.ticker} shares: <span className="num text-primary">USD({pair.base.symbol})</span>{" "}
        &divide; <span className="num text-primary">USD({pair.quote.symbol})</span>, real reserves on
        Cookie Chain over real {pair.quote.symbol} liquidity on Solana. Nothing is modelled.
      </p>

      <dl className="space-y-2.5 text-[13px]">
        <Fact label="Base mint">
          <ExtLink href={cookieAccountUrl(pair.base.mint)}>{shortAddr(pair.base.mint, 6)}</ExtLink>
        </Fact>
        <Fact label="Deepest pool">
          {pair.poolId ? (
            <ExtLink href={cookieAccountUrl(pair.poolId)}>{pair.venue}</ExtLink>
          ) : (
            <span className="text-subtle">—</span>
          )}
        </Fact>
        <Fact label={`${pair.quote.symbol} mint`}>
          <ExtLink href={`https://solscan.io/token/${pair.quote.mint}`}>
            {shortAddr(pair.quote.mint, 6)}
          </ExtLink>
        </Fact>
        <Fact label={`1 ${pair.quote.ticker} buys`}>
          <span className="num text-primary">
            {amount(pair.inverse)} {pair.base.symbol}
          </span>
        </Fact>
        <Fact label="Holders">
          <span className="num text-primary">{pair.base.holders ?? "—"}</span>
        </Fact>
        <Fact label={`${pair.quote.symbol}, 24h`}>
          <span className="num text-primary">{pct(pair.quote.change24h)}</span>
        </Fact>
      </dl>
    </div>
  );
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
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
