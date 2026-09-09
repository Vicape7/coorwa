"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { RWA_ASSETS } from "@/lib/rwa";
import { usd, amount, rwaRatio, pct } from "@/lib/format";
import type { CorwaPair, PairUniverse } from "@/lib/pairs";
import { TokenMark } from "./token-mark";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type SortKey = "liquidity" | "volume" | "change" | "price";

const SORTS: [SortKey, string][] = [
  ["liquidity", "Liquidity"],
  ["volume", "Volume"],
  ["change", "Relative"],
  ["price", "Price"],
];

export function PairList() {
  const [ticker, setTicker] = useState("NVDA");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("liquidity");

  const { data, error, isLoading } = useSWR<PairUniverse>(`/api/pairs?quote=${ticker}`, fetcher, {
    refreshInterval: 20_000,
    keepPreviousData: true,
  });

  const rows = useMemo(() => {
    const pairs = data?.pairs ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? pairs.filter(
          (p) =>
            p.base.symbol.toLowerCase().includes(q) ||
            p.base.name.toLowerCase().includes(q) ||
            p.base.mint.toLowerCase().startsWith(q),
        )
      : pairs;

    const key = (p: CorwaPair) => {
      switch (sort) {
        case "volume":
          return p.base.volume24h ?? -1;
        case "change":
          return p.change24h ?? -Infinity;
        case "price":
          return p.price;
        default:
          return p.base.liquidityUsd;
      }
    };
    return [...filtered].sort((a, b) => key(b) - key(a));
  }, [data, query, sort]);

  const quote = data?.rwa.find((r) => r.ticker === ticker);

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <h1 className="display text-[40px] text-primary sm:text-[52px]">
            Every token, priced in shares
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Cookie Chain liquidity quoted against real equities. Two live market prices divided —
            pool reserves here, the xStock on Solana. Nothing synthetic.
          </p>
        </div>

        {quote && (
          <div className="card px-5 py-3.5">
            <div className="label">{quote.symbol}</div>
            <div className="mt-1 flex items-baseline gap-2.5">
              <span className="num text-[22px] text-primary">${quote.priceUsd.toFixed(2)}</span>
              <span className={`num text-[13px] ${toneClass(quote.change24h)}`}>
                {pct(quote.change24h)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Quote-asset selector */}
      <div className="mt-8 flex flex-wrap items-center gap-1.5">
        <span className="label mr-1.5">Quote in</span>
        {RWA_ASSETS.slice(0, 10).map((a) => (
          <button
            key={a.ticker}
            onClick={() => setTicker(a.ticker)}
            className={
              a.ticker === ticker
                ? "pill pill-active"
                : "pill pill-outline transition-colors hover:text-[color:var(--text-primary)]"
            }
          >
            {a.ticker}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a token, or paste a mint"
          className="field w-full sm:w-80"
        />
        <div className="segmented ml-auto">
          {SORTS.map(([k, label]) => (
            <button key={k} onClick={() => setSort(k)} data-active={sort === k}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card mt-4 p-5 text-[14px] text-[color:var(--color-down)]">
          Could not reach the pair feed.
        </div>
      )}

      <div className="card mt-4 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[14px]">
            <thead>
              <tr className="border-b border-hair">
                <Th className="w-[28%]">Pair</Th>
                <Th align="right">Price in {ticker}</Th>
                <Th align="right">1 {ticker} buys</Th>
                <Th align="right">vs {ticker} 24h</Th>
                <Th align="right">Liquidity</Th>
                <Th align="right">Volume 24h</Th>
                <Th>Venue</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && !data
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
                : rows.map((p) => <Row key={p.slug} pair={p} ticker={ticker} />)}
            </tbody>
          </table>
        </div>

        {!isLoading && rows.length === 0 && (
          <div className="p-10 text-center text-[14px] text-muted">No token matches that search.</div>
        )}
      </div>

      {data && (
        <p className="mt-4 text-[12px] text-subtle">
          {data.pairs.length} pairs · COOK at <span className="num">{usd(data.cookPriceUsd)}</span> ·
          refreshed every 20s. Liquidity is summed across every pool a token trades in.
        </p>
      )}
    </div>
  );
}

function Th({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      className={`label whitespace-nowrap px-4 py-3 font-normal ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

function toneClass(v: number | null | undefined) {
  if (v == null) return "text-subtle";
  return v >= 0 ? "text-[color:var(--color-up)]" : "text-[color:var(--color-down)]";
}

function Row({ pair, ticker }: { pair: CorwaPair; ticker: string }) {
  return (
    <tr className="row-hover border-b border-hair last:border-0">
      <td className="px-4 py-3">
        <Link href={`/terminal/${pair.slug}`} className="flex items-center gap-3">
          <TokenMark logo={pair.base.logo} symbol={pair.base.symbol} />
          <span className="min-w-0">
            <span className="block truncate text-primary">
              {pair.base.symbol}
              <span className="text-subtle"> / {ticker}</span>
            </span>
            <span className="block truncate text-[12px] text-subtle">{pair.base.name}</span>
          </span>
        </Link>
      </td>
      <td className="num px-4 py-3 text-right text-primary">{rwaRatio(pair.price)}</td>
      <td className="num px-4 py-3 text-right text-muted">{amount(pair.inverse)}</td>
      <td className={`num px-4 py-3 text-right ${toneClass(pair.change24h)}`}>
        {pair.change24h == null ? (
          <span title="No fills in the last 24h. A flat price against a moving stock is not a real return, so Corwa shows nothing rather than a phantom gain.">
            &mdash;
          </span>
        ) : (
          pct(pair.change24h)
        )}
      </td>
      <td className="num px-4 py-3 text-right text-primary">{usd(pair.base.liquidityUsd)}</td>
      <td className="num px-4 py-3 text-right text-muted">
        {pair.base.volume24h ? usd(pair.base.volume24h) : "—"}
      </td>
      <td className="px-4 py-3">
        <span className="pill pill-quiet text-[11px]">{pair.venue ?? "—"}</span>
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-hair">
      {Array.from({ length: 7 }).map((_, i) => (
        <td key={i} className="px-4 py-4">
          <div className="skeleton h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}
