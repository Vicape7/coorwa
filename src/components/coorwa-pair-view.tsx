"use client";

/**
 * The pair page for a token on Coorwa's own curve.
 *
 * The same layout as the launchpad curve's page, with three differences that matter: the price
 * comes from the curve account rather than a feed, the fills come from the program's own events,
 * and the panel builds its trades in this page. What the token pays its holders is its transfer
 * tax, so that is what the facts below lead with.
 */
import Link from "next/link";
import useSWR from "swr";
import { RatioChart } from "./ratio-chart";
import { RecentTrades } from "./recent-trades";
import { CoorwaPanel } from "./coorwa-panel";
import { TokenMark } from "./token-mark";
import { Metric, HolderRewards, Fact, ExtLink } from "./pair-view";
import { usd, amount, rwaRatio, pct, shortAddr } from "@/lib/format";
import { COOK_DECIMALS, cookieAccountUrl } from "@/lib/config";
import type { CoorwaPair } from "@/lib/coorwa-pairs";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function CoorwaPairView({ initial }: { initial: CoorwaPair }) {
  const { data } = useSWR<CoorwaPair>(`/api/pair/${initial.slug}/coorwa`, fetcher, {
    refreshInterval: 15_000,
    fallbackData: initial,
    keepPreviousData: true,
  });
  const pair = data && "curve" in data ? data : initial;
  const { curve } = pair;
  const targetCook = Number(curve.graduationQuote) / 10 ** COOK_DECIMALS;
  const raisedCook = Number(curve.quoteRaised) / 10 ** COOK_DECIMALS;

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-6">
      <Link
        href="/terminal"
        className="text-[13px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
      >
        &larr; All pairs
      </Link>

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
              {pair.base.name} priced in {pair.quote.name} shares ·{" "}
              {curve.state === "live"
                ? "on Coorwa's curve"
                : pair.pool
                  ? "graduated, trading in its locked pool"
                  : "graduated, its pool is opening"}
            </p>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
          <Metric
            label={`${pair.base.symbol} in ${pair.quote.ticker}`}
            value={rwaRatio(pair.price)}
            sub={pair.inverse ? `${amount(pair.inverse, 2)} per share` : undefined}
          />
          <Metric label="Price" value={pair.priceUsd ? usd(pair.priceUsd) : "—"} />
          <Metric
            label={`${pair.quote.ticker} share`}
            value={usd(pair.quote.priceUsd)}
            sub={pair.quote.change24h != null ? pct(pair.quote.change24h) : undefined}
          />
          <Metric label="Tax to holders" value={`${curve.taxBps / 100}%`} sub="every transfer" />
        </div>
      </div>

      {/* Progress to graduation, the one number a curve is really about; after it, the pool. */}
      {pair.pool ? (
        <div className="card mt-5 flex flex-wrap items-baseline justify-between gap-2 p-5">
          <span className="text-[13px] text-muted">
            Graduated with {amount(raisedCook, 0)} COOK. The pool holds{" "}
            {amount(pair.pool.cookHeld, 0)} COOK
            {pair.pool.liquidityUsd != null && (
              <span className="text-subtle"> · {usd(pair.pool.liquidityUsd)} of liquidity</span>
            )}
          </span>
          <span className="text-[13px] text-primary">Locked for good</span>
        </div>
      ) : (
        <div className="card mt-5 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[13px] text-muted">
              {amount(raisedCook, 0)} of {amount(targetCook, 0)} COOK raised
              {pair.raisedUsd != null && <span className="text-subtle"> · {usd(pair.raisedUsd)}</span>}
            </span>
            <span className="num text-[13px] text-primary">
              {Math.round(curve.progress * 100)}% to graduation
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[color:var(--surface-sunken)]">
            <div
              className="h-full rounded-full bg-[var(--color-cookie)]"
              style={{ width: `${Math.min(100, Math.round(curve.progress * 100))}%` }}
            />
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <RatioChart
            mint={pair.base.mint}
            ticker={pair.quote.ticker}
            baseSymbol={pair.base.symbol}
            pool={curve.address}
            venue="coorwa"
          />
          <RecentTrades
            mint={pair.base.mint}
            baseSymbol={pair.base.symbol}
            ticker={pair.quote.ticker}
            rwaPriceUsd={pair.quote.priceUsd}
            pool={curve.address}
            venue="coorwa"
          />
        </div>

        <div className="space-y-4">
          <CoorwaPanel pair={pair} />
          <HolderRewards
            mint={pair.base.mint}
            symbol={pair.base.symbol}
            stock={pair.quote.ticker}
            taxBps={curve.taxBps}
          />

          <div className="card p-5 sm:p-6">
            <h2 className="title text-primary">Facts</h2>
            <dl className="mt-4 space-y-3 text-[13px]">
              <Fact label="Tax on every transfer">{curve.taxBps / 100}% to holders</Fact>
              <Fact label={pair.pool ? "Curve fee, while it ran" : "Curve fee"}>
                {curve.curveFeeBps / 100}% to Coorwa
              </Fact>
              <Fact label="Creator&apos;s share after graduation">
                {curve.creatorLpShareBps / 100}% of the pool&apos;s fees
              </Fact>
              <Fact label="Mint">
                <ExtLink href={cookieAccountUrl(pair.base.mint)}>
                  {shortAddr(pair.base.mint, 6)}
                </ExtLink>
              </Fact>
              <Fact label="Curve">
                <ExtLink href={cookieAccountUrl(curve.address)}>
                  {shortAddr(curve.address, 6)}
                </ExtLink>
              </Fact>
              {pair.pool && (
                <Fact label="Pool">
                  <ExtLink href={cookieAccountUrl(pair.pool.address)}>
                    {shortAddr(pair.pool.address, 6)}
                  </ExtLink>
                </Fact>
              )}
              <Fact label="Creator">
                <ExtLink href={cookieAccountUrl(curve.creator)}>
                  {shortAddr(curve.creator, 6)}
                </ExtLink>
              </Fact>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
