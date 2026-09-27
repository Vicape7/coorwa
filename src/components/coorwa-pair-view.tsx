"use client";

/**
 * The pair page for a token on Coorwa's own curve, and in its pool once it graduates.
 *
 * The same frame as every pair page, with three differences that matter: the price comes from the
 * curve or pool account rather than a feed, the fills come from the program's own events, and the
 * panel builds its trades in this page. What the token pays its holders is its transfer tax, so
 * that is what the About strip leads with.
 */
import { useCallback, useState } from "react";
import useSWR from "swr";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { RatioChart } from "./ratio-chart";
import { RecentTrades } from "./recent-trades";
import { CoorwaPanel } from "./coorwa-panel";
import { GraduationNotice, type GraduationEvent } from "./graduation";
import { HolderRewards, Fact, ExtLink } from "./pair-view";
import { ActivityCard, PairLayout, PanelIdentity, useRewardPool } from "./pair-layout";
import { usd, amount, rwaRatio, shortAddr } from "@/lib/format";
import { COOK_DECIMALS, CURVE_TOKEN_DECIMALS, cookieAccountUrl } from "@/lib/config";
import { TOTAL_SUPPLY } from "@/lib/launch-params";
import { fetchCurve } from "@/lib/launch-program";
import { serialiseCurve } from "@/lib/launch-flow";
import type { CoorwaPair } from "@/lib/coorwa-pairs";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function CoorwaPairView({ initial }: { initial: CoorwaPair }) {
  const { connection } = useConnection();
  const { data, mutate } = useSWR<CoorwaPair>(`/api/pair/${initial.slug}/coorwa`, fetcher, {
    // Quicker while the pool is being opened, so the page moves on to it as soon as it exists.
    refreshInterval: (latest) => (latest?.curve?.state === "graduated" ? 3_000 : 15_000),
    fallbackData: initial,
    keepPreviousData: true,
  });
  const pair = data && "curve" in data ? data : initial;
  const { curve } = pair;

  // A graduation seen while the page is open, raised once per step: the curve filling, then the
  // pool opening. Derived during render from the state the page last drew.
  const [seenState, setSeenState] = useState(curve.state);
  const [event, setEvent] = useState<GraduationEvent | null>(null);
  if (curve.state !== seenState) {
    setSeenState(curve.state);
    if (seenState === "live" && event?.kind !== "graduated") {
      setEvent({ kind: "graduated", mine: false, id: (event?.id ?? 0) + 1 });
    } else if (seenState === "graduated" && curve.state === "pooled" && !event) {
      setEvent({ kind: "pooled", mine: false, id: 1 });
    }
  }
  const closeEvent = useCallback(() => setEvent(null), []);

  /**
   * After a trade: the curve read straight off the chain and drawn at once, then the whole pair from
   * the server for the price and the rest. The chain read is one account and lands in well under a
   * second; the server's answer carries prices and the day's fills and takes longer.
   */
  const onTraded = useCallback(
    ({ graduates }: { graduates: boolean }) => {
      if (graduates) setEvent((e) => ({ kind: "graduated", mine: true, id: (e?.id ?? 0) + 1 }));
      void (async () => {
        const fresh = await fetchCurve(connection, new PublicKey(initial.base.mint)).catch(() => null);
        if (fresh) {
          await mutate(
            (current) => (current && "curve" in current ? { ...current, curve: serialiseCurve(fresh) } : current),
            { revalidate: false },
          );
        }
        await mutate();
      })();
    },
    [connection, initial.base.mint, mutate],
  );
  const { pool: rewards } = useRewardPool(pair.base.mint);
  const targetCook = Number(curve.graduationQuote) / 10 ** COOK_DECIMALS;
  const raisedCook = Number(curve.quoteRaised) / 10 ** COOK_DECIMALS;
  const supply = Number(TOTAL_SUPPLY) / 10 ** CURVE_TOKEN_DECIMALS;
  const venue =
    curve.state === "live"
      ? "on Coorwa's curve"
      : pair.pool
        ? "graduated, trading in its locked pool"
        : "graduated, its pool is opening";

  return (
    <PairLayout
      about={
        <>
          The {curve.taxBps / 100}% tax on every {pair.base.symbol} transfer goes back to its holders,
          paid once a day in {pair.quote.symbol} on Solana. {pair.base.name} is priced in{" "}
          {pair.quote.name} shares, {venue}.
        </>
      }
      stats={[
        { label: "Paid to holders", value: usd(rewards?.holdersPaidUsd ?? 0) },
        { label: "Waiting to distribute", value: usd(rewards?.holdersWaitingUsd ?? 0) },
        pair.pool
          ? { label: "Pool, locked for good", value: `${amount(pair.pool.cookHeld, 0)} COOK` }
          : {
              label: "Graduation",
              value: `${amount(raisedCook, 0)} / ${amount(targetCook, 0)} COOK`,
              count: { to: raisedCook, format: (n) => `${amount(Math.round(n), 0)} / ${amount(targetCook, 0)} COOK` },
              progress: curve.progress,
            },
      ]}
      links={[
        { label: "Explorer", href: cookieAccountUrl(pair.base.mint), icon: "explorer" },
        { label: "Contract", copy: pair.base.mint, icon: "copy" },
        pair.pool
          ? { label: "Pool", href: cookieAccountUrl(pair.pool.address), icon: "pool" }
          : { label: "Curve", href: cookieAccountUrl(curve.address), icon: "pool" },
        {
          label: pair.quote.symbol,
          href: `https://solscan.io/token/${pair.quote.mint}`,
          icon: "stock",
        },
      ]}
      panel={
        <>
          <CoorwaPanel
            pair={pair}
            onTraded={onTraded}
            header={
              <PanelIdentity
                logo={pair.base.logo}
                name={pair.base.name}
                symbol={pair.base.symbol}
                sub={`priced in ${pair.quote.ticker}`}
              />
            }
          />
          {/* Drawn over the page through a portal; it sits here only to belong to the panel. */}
          {event && (
            <GraduationNotice
              event={event}
              state={curve.state}
              symbol={pair.base.symbol}
              logo={pair.base.logo}
              raisedCook={raisedCook}
              poolHref={pair.pool ? cookieAccountUrl(pair.pool.address) : null}
              onClose={closeEvent}
            />
          )}
        </>
      }
      chart={
        <RatioChart
          mint={pair.base.mint}
          ticker={pair.quote.ticker}
          baseSymbol={pair.base.symbol}
          pool={curve.address}
          venue="coorwa"
          stats={[
            { label: "Market cap", value: usd(pair.priceUsd != null ? pair.priceUsd * supply : null) },
            pair.pool
              ? { label: "Liquidity", value: usd(pair.pool.liquidityUsd) }
              : { label: "Raised", value: usd(pair.raisedUsd) },
            { label: "24h volume", value: usd(pair.volume24h) },
            { label: "Price", value: usd(pair.priceUsd) },
          ]}
          headline={{
            value: rwaRatio(pair.price),
            unit: pair.quote.ticker,
            change: pair.vsStock24h,
            changeLabel: `vs ${pair.quote.ticker}, 24h`,
          }}
        />
      }
      activity={
        <ActivityCard
          fills={
            <RecentTrades
              mint={pair.base.mint}
              baseSymbol={pair.base.symbol}
              ticker={pair.quote.ticker}
              rwaPriceUsd={pair.quote.priceUsd}
              pool={curve.address}
              venue="coorwa"
            />
          }
          rewards={
            <HolderRewards
              mint={pair.base.mint}
              symbol={pair.base.symbol}
              stock={pair.quote.ticker}
              taxBps={curve.taxBps}
            />
          }
          facts={
            <dl className="grid gap-x-10 gap-y-2.5 px-1 text-[13px] md:grid-cols-2">
              <Fact label="Tax on every transfer">{curve.taxBps / 100}% to holders</Fact>
              <Fact label={pair.pool ? "Curve fee, while it ran" : "Curve fee"}>
                {curve.curveFeeBps / 100}% to Coorwa
              </Fact>
              <Fact label="Creator&apos;s share after graduation">
                {curve.creatorLpShareBps / 100}% of the pool&apos;s fees
              </Fact>
              <Fact label={`1 ${pair.quote.ticker} buys`}>
                <span className="num">
                  {pair.inverse ? `${amount(pair.inverse, 2)} ${pair.base.symbol}` : "—"}
                </span>
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
          }
        />
      }
    />
  );
}
