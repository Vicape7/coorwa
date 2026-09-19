"use client";

/**
 * The pair page for a token still on its launchpad curve. Laid out like `PairView`, but the price
 * comes from the curve's reserves, the fills from MomoSwap's indexer, and trading goes through the
 * curve itself, since there is no pool to swap against until the token graduates.
 */
import Link from "next/link";
import useSWR from "swr";
import { RatioChart } from "./ratio-chart";
import { RecentTrades } from "./recent-trades";
import { CurvePanel } from "./curve-panel";
import { TokenMark } from "./token-mark";
import { Metric, HolderRewards, Fact, ExtLink } from "./pair-view";
import { usd, amount, rwaRatio, pct, shortAddr } from "@/lib/format";
import {
  COOK_DECIMALS,
  CURVE_TOKEN_DECIMALS,
  MOMOSWAP_SITE,
  cookieAccountUrl,
} from "@/lib/config";
import type { CurvePair } from "@/lib/curve-pairs";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function CurvePairView({ initial }: { initial: CurvePair }) {
  const { data } = useSWR<CurvePair>(`/api/pair/${initial.slug}/curve`, fetcher, {
    refreshInterval: 15_000,
    fallbackData: initial,
    keepPreviousData: true,
  });
  // A failed refresh answers with an error body; keep the last good pair rather than render it.
  const pair = data && "pool" in data ? data : initial;
  const { pool } = pair;
  const targetCook = Number(pool.graduationTarget) / 10 ** COOK_DECIMALS;

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
              {pair.base.name} priced in {pair.quote.name} shares · on the launchpad curve
            </p>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
          <Metric
            label="Price"
            value={pair.price ? rwaRatio(pair.price) : "—"}
            sub={`${pair.quote.ticker} per token`}
          />
          <Metric
            label={`1 ${pair.quote.ticker} buys`}
            value={pair.inverse ? amount(pair.inverse) : "—"}
            sub={pair.base.symbol}
          />
          <Metric
            label="Graduation"
            value={`${Math.floor(pool.progress * 100)}%`}
            sub={`of ${amount(targetCook)} COOK`}
          />
          <Metric
            label="Raised"
            value={pair.raisedUsd == null ? "—" : usd(pair.raisedUsd)}
            sub={`${pool.participantCount} holders`}
          />
          <Metric
            label={`${pair.quote.symbol} spot`}
            value={`$${pair.quote.priceUsd.toFixed(2)}`}
            sub={pct(pair.quote.change24h)}
            subTone={(pair.quote.change24h ?? 0) >= 0 ? "up" : "down"}
          />
        </div>
      </div>

      {/* Body: the same phone order as a pool pair, chart > trade > fills. */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_396px]">
        <div className="contents lg:flex lg:min-h-[460px] lg:flex-col lg:gap-4">
          <div className="min-w-0 lg:contents">
            <RatioChart
              mint={pair.base.mint}
              ticker={pair.quote.ticker}
              baseSymbol={pair.base.symbol}
              pool={pool.pubkey}
            />
          </div>
          <div className="order-3 min-w-0 lg:contents">
            <RecentTrades
              mint={pair.base.mint}
              baseSymbol={pair.base.symbol}
              rwaPriceUsd={pair.quote.priceUsd}
              ticker={pair.quote.ticker}
              pool={pool.pubkey}
            />
          </div>
        </div>

        <div className="contents lg:block lg:space-y-4">
          <div className="order-2 min-w-0 lg:contents">
            <CurvePanel
              pool={pool}
              decimals={CURVE_TOKEN_DECIMALS}
              cookPriceUsd={pair.cookPriceUsd}
            />
          </div>

          <div className="order-4 min-w-0 lg:contents">
            <HolderRewards
              mint={pair.base.mint}
              symbol={pair.base.symbol}
              stock={pair.quote.symbol}
            />
          </div>

          <div className="order-5 min-w-0 lg:contents">
            <CurveFacts pair={pair} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CurveFacts({ pair }: { pair: CurvePair }) {
  return (
    <div className="card p-5">
      <div className="label">How this pair is priced</div>
      <p className="mt-2.5 text-[13px] leading-[1.7] text-muted">
        {pair.base.symbol} trades on its MomoSwap bonding curve until it reaches the graduation
        target, then moves to a real pool. It is priced live in {pair.quote.ticker} shares:{" "}
        <span className="num text-primary">USD({pair.base.symbol})</span> &divide;{" "}
        <span className="num text-primary">USD({pair.quote.symbol})</span>, the curve&apos;s reserves
        on Cookie Chain over real {pair.quote.symbol} liquidity on Solana. Nothing is modelled.
      </p>

      <dl className="mt-4 space-y-2 border-t border-hair pt-4 text-[13px]">
        <Fact label="Base mint">
          <ExtLink href={cookieAccountUrl(pair.base.mint)}>{shortAddr(pair.base.mint, 6)}</ExtLink>
        </Fact>
        <Fact label="Curve">
          <ExtLink href={`${MOMOSWAP_SITE}/token/${pair.base.mint}`}>MomoSwap</ExtLink>
        </Fact>
        <Fact label={`${pair.quote.symbol} mint`}>
          <ExtLink href={`https://solscan.io/token/${pair.quote.mint}`}>
            {shortAddr(pair.quote.mint, 6)}
          </ExtLink>
        </Fact>
        <Fact label="Holders">
          <span className="num text-primary">{pair.pool.participantCount}</span>
        </Fact>
      </dl>
    </div>
  );
}
