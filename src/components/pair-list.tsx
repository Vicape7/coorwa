"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { RWA_ASSETS } from "@/lib/rwa";
import { usd, amount, rwaRatio, pct } from "@/lib/format";
import type { CoorwaPair, PairUniverse } from "@/lib/pairs";
import { TokenMark } from "./token-mark";
import { SearchGlyph } from "./ui/glyphs";
import { PillSelect } from "./ui/pill-select";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type SortKey = "liquidity" | "volume" | "change" | "price";

/** Every listed pair, each in its own asset. The default: most tokens carry one pair or two. */
const ALL = "ALL";

const SORTS: [SortKey, string][] = [
  ["liquidity", "Liquidity"],
  ["volume", "Volume"],
  ["change", "Relative"],
  ["price", "Price"],
];

export function PairList({
  initialQuery = "",
  initialQuote,
}: {
  initialQuery?: string;
  initialQuote?: string;
}) {
  const [ticker, setTicker] = useState(
    () => RWA_ASSETS.find((a) => a.ticker === initialQuote)?.ticker ?? ALL,
  );
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState<SortKey>("liquidity");

  const { data, error, isLoading } = useSWR<PairUniverse>(
    ticker === ALL ? "/api/pairs" : `/api/pairs?quote=${ticker}`,
    fetcher,
    { refreshInterval: 20_000, keepPreviousData: true },
  );

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

    const key = (p: CoorwaPair) => {
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

  const quote = ticker === ALL ? undefined : data?.rwa.find((r) => r.ticker === ticker);
  const unit = ticker === ALL ? "asset" : ticker;

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <h1 className="display text-[30px] text-primary sm:text-[36px]">
          Tokens, priced in shares
        </h1>

        {quote && (
          <div className="flex items-baseline gap-2.5">
            <span className="label">{quote.symbol}</span>
            <span className="num text-[20px] text-primary">${quote.priceUsd.toFixed(2)}</span>
            <span className={`num text-[13px] ${toneClass(quote.change24h)}`}>
              {pct(quote.change24h)}
            </span>
          </div>
        )}
      </div>

      {/*
       * One row holds everything the terminal can be told to do. The sixteen quote assets and the
       * four sort orders used to be fourteen buttons sitting on the surface; they are the same two
       * controls now, and the search field is the only thing with any visual weight.
       */}
      <div className="card mt-6 flex flex-wrap items-center gap-2 py-2 pl-5 pr-2">
        <SearchGlyph />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a token, or paste a mint"
          aria-label="Search tokens"
          className="min-w-[12rem] flex-1 bg-transparent text-[15px] text-primary outline-none placeholder:text-[color:var(--text-subtle)]"
        />
        <PillSelect
          id="terminal-quote"
          label="Quote in"
          value={ticker}
          onChange={setTicker}
          options={[
            { value: ALL, label: "All" },
            ...RWA_ASSETS.map((a) => ({ value: a.ticker, label: a.ticker })),
          ]}
        />
        <PillSelect
          id="terminal-sort"
          label="Sort by"
          prefix="Sort"
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
          options={SORTS.map(([value, label]) => ({ value, label }))}
        />
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
                <Th align="right">Price in {unit}</Th>
                <Th align="right">1 {unit} buys</Th>
                <Th align="right">vs {unit} 24h</Th>
                <Th align="right">Liquidity</Th>
                <Th align="right">Volume 24h</Th>
                <Th>Venue</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && !data
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
                : rows.map((p) => <Row key={p.slug} pair={p} />)}
            </tbody>
          </table>
        </div>

        {!isLoading && data && rows.length === 0 && (
          <div className="p-10 text-center text-[14px] text-muted">
            {query.trim() ? (
              "No token matches that search."
            ) : (
              <>
                No pairs {ticker === ALL ? "listed yet" : `in ${ticker} yet`}. A token appears here
                once somebody gives it a pair, which anyone can do on{" "}
                <Link href="/pools" className="text-primary underline underline-offset-4">
                  Pools
                </Link>
                .
              </>
            )}
          </div>
        )}
      </div>

      {data && (
        <p className="mt-4 text-[12px] text-subtle">
          {data.pairs.length} pairs · COOK at <span className="num">{usd(data.cookPriceUsd)}</span>{" "}
          · refreshed every 20s. Liquidity is summed across every pool a token trades in.
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

function Row({ pair }: { pair: CoorwaPair }) {
  const ticker = pair.quote.ticker;
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
          <span title="No fills in the last 24h. A flat price against a moving stock is not a real return, so Coorwa shows nothing rather than a phantom gain.">
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
