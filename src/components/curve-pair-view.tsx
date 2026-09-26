"use client";

/**
 * The pair page for a token still on its launchpad curve. Framed like `PairView`, but the price
 * comes from the curve's reserves, the fills from MomoSwap's indexer, and trading goes through the
 * curve itself, since there is no pool to swap against until the token graduates.
 */
import useSWR from "swr";
import { RatioChart } from "./ratio-chart";
import { RecentTrades } from "./recent-trades";
import { CurvePanel } from "./curve-panel";
import { HolderRewards, Fact, ExtLink } from "./pair-view";
import { ActivityCard, PairLayout, useRewardPool } from "./pair-layout";
import { usd, amount, rwaRatio, shortAddr } from "@/lib/format";
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
  const { pool: rewards } = useRewardPool(pair.base.mint);

  return (
    <PairLayout
      about={
        <>
          {pair.base.name} trades on its MomoSwap curve until it reaches the graduation target, then
          moves to a real pool. Every fee Coorwa earns on it goes back to its holders, paid once a
          day in {pair.quote.symbol} on Solana.
        </>
      }
      stats={[
        { label: "Paid to holders", value: usd(rewards?.holdersPaidUsd ?? 0) },
        { label: "Waiting to distribute", value: usd(rewards?.holdersWaitingUsd ?? 0) },
        {
          label: pool.status === "graduated" ? "Graduated" : "Graduation",
          value: `${Math.floor(pool.progress * 100)}% of ${amount(targetCook, 0)} COOK`,
          progress: pool.progress,
        },
      ]}
      links={[
        { label: "Explorer", href: cookieAccountUrl(pair.base.mint), icon: "explorer" },
        { label: "Contract", copy: pair.base.mint, icon: "copy" },
        { label: "MomoSwap", href: `${MOMOSWAP_SITE}/token/${pair.base.mint}`, icon: "pool" },
        {
          label: pair.quote.symbol,
          href: `https://solscan.io/token/${pair.quote.mint}`,
          icon: "stock",
        },
      ]}
      panel={
        <CurvePanel pool={pool} decimals={CURVE_TOKEN_DECIMALS} cookPriceUsd={pair.cookPriceUsd} />
      }
      chart={
        <RatioChart
          mint={pair.base.mint}
          ticker={pair.quote.ticker}
          baseSymbol={pair.base.symbol}
          pool={pool.pubkey}
          stats={[
            { label: "Raised", value: pair.raisedUsd == null ? "—" : usd(pair.raisedUsd) },
            { label: "Holders", value: String(pool.participantCount) },
            { label: "Price", value: usd(pair.priceUsd) },
            {
              label: `${pair.quote.symbol} share`,
              value: `$${pair.quote.priceUsd.toFixed(2)}`,
            },
          ]}
          headline={{ value: pair.price ? rwaRatio(pair.price) : "—", unit: pair.quote.ticker }}
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
              pool={pool.pubkey}
            />
          }
          rewards={
            <HolderRewards
              mint={pair.base.mint}
              symbol={pair.base.symbol}
              stock={pair.quote.symbol}
            />
          }
          facts={<CurveFacts pair={pair} />}
        />
      }
    />
  );
}

function CurveFacts({ pair }: { pair: CurvePair }) {
  return (
    <div className="grid gap-6 px-1 md:grid-cols-2 md:gap-10">
      <p className="text-[13px] leading-[1.7] text-muted">
        {pair.base.symbol} trades on its MomoSwap bonding curve until it reaches the graduation
        target, then moves to a real pool. It is priced live in {pair.quote.ticker} shares:{" "}
        <span className="num text-primary">USD({pair.base.symbol})</span> &divide;{" "}
        <span className="num text-primary">USD({pair.quote.symbol})</span>, the curve&apos;s reserves
        on Cookie Chain over real {pair.quote.symbol} liquidity on Solana. Nothing is modelled.
      </p>

      <dl className="space-y-2.5 text-[13px]">
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
