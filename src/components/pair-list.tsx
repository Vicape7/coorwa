"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { RWA_ASSETS } from "@/lib/rwa";
import { usd, amount, rwaRatio, pct } from "@/lib/format";
import { curvePrice } from "@/lib/curve";
import { COOK_DECIMALS, CURVE_TOKEN_DECIMALS } from "@/lib/config";
import type { CoorwaPair, PairUniverse } from "@/lib/pairs";
import type { LaunchpadPool } from "@/lib/launchpad";
import type { CoorwaPair as CoorwaCurvePair } from "@/lib/coorwa-pairs";
import { TokenMark } from "./token-mark";
import { SearchGlyph } from "./ui/glyphs";
import { PillSelect } from "./ui/pill-select";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type SortKey = "liquidity" | "volume" | "change" | "price";

/** Every listed pair, each in its own asset. The default: most tokens carry one pair or two. */
const ALL = "ALL";

/**
 * Where a pair stands. New and Soon are launches still on a curve, split at 60% of the graduation
 * target. Migrated is every pair whose token trades in a real pool. A curve that has graduated
 * stays in Soon, marked as migrating, until its pool shows up in Migrated, so a token never drops
 * out of the terminal between the two.
 *
 * Two kinds of curve land in those first two tabs: Coorwa's own, which is where every new launch
 * goes, and the MomoSwap curves of tokens launched before that. They are listed side by side and
 * read the same, because to whoever is buying they are the same thing.
 */
type Stage = "new" | "soon" | "migrated";

const STAGES: [Stage, string][] = [
  ["new", "New"],
  ["soon", "Soon"],
  ["migrated", "Migrated"],
];

/** Share of the graduation target a curve needs to count as about to migrate. */
const SOON_AT = 0.6;

type CurvePool = LaunchpadPool & { progress: number; logo: string | null; ticker: string | null };

/**
 * One row of a curve tab, whichever program the curve belongs to.
 *
 * The two sources answer with quite different objects, so they are flattened to this before the
 * table sees either: the table then has one shape to render and no idea which venue a row came
 * from, apart from the label it prints.
 */
interface CurveListRow {
  key: string;
  href: string;
  mint: string;
  ticker: string;
  symbol: string;
  name: string;
  logo: string | null;
  /** Shares of the pair's stock one token is worth. */
  ratio: number | null;
  progress: number;
  migrating: boolean;
  raisedUsd: number | null;
  holders: number | null;
  /** Unix seconds the curve opened, for the age column. */
  startedAt: number;
  venue: "Coorwa" | "MomoSwap";
}

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
  const [stage, setStage] = useState<Stage>("migrated");
  const onCurve = stage !== "migrated";

  const { data, error, isLoading } = useSWR<PairUniverse>(
    ticker === ALL ? "/api/pairs" : `/api/pairs?quote=${ticker}`,
    fetcher,
    { refreshInterval: 20_000, keepPreviousData: true },
  );
  // Asked for only once a curve tab is open. The pair feed above still supplies the stock prices.
  const curves = useSWR<{ pools: CurvePool[]; cookPriceUsd: number | null }>(
    onCurve ? "/api/launchpad/pools?status=all" : null,
    fetcher,
    { refreshInterval: 20_000, keepPreviousData: true },
  );

  const coorwaCurves = useSWR<{ pairs: CoorwaCurvePair[] }>(
    onCurve ? "/api/coorwa/curves" : null,
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

  const stockPrices = useMemo(
    () => new Map((data?.rwa ?? []).map((r) => [r.ticker, r.priceUsd])),
    [data],
  );
  const cookUsd = curves.data?.cookPriceUsd ?? data?.cookPriceUsd ?? null;

  const curveRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pooled = new Set((data?.pairs ?? []).map((p) => p.base.mint));
    const stockOf = (t: string) => stockPrices.get(t) ?? null;

    const fromLaunchpad = (p: CurvePool): CurveListRow => ({
      key: p.pubkey,
      href: curveHref(p.tokenMint, p.ticker ?? ""),
      mint: p.tokenMint,
      ticker: p.ticker ?? "",
      symbol: p.symbol,
      name: p.name,
      logo: p.logo,
      ratio: curveRatio(p, stockOf(p.ticker ?? ""), cookUsd),
      progress: p.progress,
      migrating: p.status === "graduated",
      raisedUsd: cookUsd ? (Number(p.paymentRaisedNet) / 10 ** COOK_DECIMALS) * cookUsd : null,
      holders: Number(p.participantCount),
      startedAt: p.launchTs,
      venue: "MomoSwap",
    });

    const fromCoorwa = (p: CoorwaCurvePair): CurveListRow => ({
      key: p.curve.address,
      href: curveHref(p.base.mint, p.quote.ticker),
      mint: p.base.mint,
      ticker: p.quote.ticker,
      symbol: p.base.symbol,
      name: p.base.name,
      logo: p.base.logo,
      ratio: p.price,
      progress: p.curve.progress,
      migrating: p.curve.state !== "live",
      raisedUsd: p.raisedUsd,
      // Nothing counts a curve's holders yet, and a made-up number would be worse than none.
      holders: null,
      startedAt: p.curve.startedAt,
      venue: "Coorwa",
    });

    const inStage = (row: CurveListRow) =>
      row.migrating
        ? stage === "soon" && !pooled.has(row.mint)
        : stage === "soon"
          ? row.progress >= SOON_AT
          : row.progress < SOON_AT;

    const rows: CurveListRow[] = [
      ...(coorwaCurves.data?.pairs ?? []).map(fromCoorwa),
      ...(curves.data?.pools ?? []).filter((p) => p.ticker != null && (p.status === "live" || p.status === "graduated")).map(fromLaunchpad),
    ];

    return rows
      .filter(
        (row) =>
          row.ticker !== "" &&
          (ticker === ALL || row.ticker === ticker) &&
          inStage(row) &&
          (!q ||
            row.symbol.toLowerCase().includes(q) ||
            row.name.toLowerCase().includes(q) ||
            row.mint.toLowerCase().startsWith(q)),
      )
      // Newest first on New; on Soon, whichever is closest to its pool.
      .sort((a, b) => (stage === "soon" ? b.progress - a.progress : b.startedAt - a.startedAt));
  }, [coorwaCurves.data, curves.data, data, query, ticker, stage, stockPrices, cookUsd]);

  const loading = onCurve ? !curves.data || !data : isLoading && !data;
  const shown = onCurve ? curveRows.length : rows.length;

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

      <div className="segmented mt-6 w-full sm:w-auto">
        {STAGES.map(([value, label]) => (
          <button key={value} onClick={() => setStage(value)} data-active={stage === value}>
            {label}
          </button>
        ))}
      </div>

      {/*
       * One row holds everything the terminal can be told to do. The sixteen quote assets and the
       * four sort orders used to be fourteen buttons sitting on the surface; they are the same two
       * controls now, and the search field is the only thing with any visual weight.
       */}
      <div className="card mt-4 flex flex-wrap items-center gap-2 py-2 pl-5 pr-2">
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
        {!onCurve && (
          <PillSelect
            id="terminal-sort"
            label="Sort by"
            prefix="Sort"
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={SORTS.map(([value, label]) => ({ value, label }))}
          />
        )}
      </div>

      {(onCurve ? curves.error : error) && (
        <div className="card mt-4 p-5 text-[14px] text-[color:var(--color-down)]">
          Could not reach the {onCurve ? "launchpad" : "pair"} feed.
        </div>
      )}

      <div className="card mt-4 overflow-hidden">
        {/* On a phone seven columns only ever showed two, so each pair becomes one compact row. */}
        <ul className="sm:hidden">
          {loading
            ? Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="border-b border-hair px-4 py-4 last:border-0">
                  <div className="skeleton h-8 w-full" />
                </li>
              ))
            : onCurve
              ? curveRows.map((row) => <MobileCurveRow key={row.key} row={row} />)
              : rows.map((p) => <MobileRow key={p.slug} pair={p} />)}
        </ul>

        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[900px] text-[14px]">
            {onCurve ? (
              <CurveTable rows={curveRows} loading={loading} unit={unit} />
            ) : (
              <PairTable rows={rows} loading={loading} unit={unit} />
            )}
          </table>
        </div>

        {!loading && shown === 0 && (
          <div className="p-10 text-center text-[14px] text-muted">
            {query.trim() ? (
              "No token matches that search."
            ) : onCurve ? (
              <>
                {stage === "soon"
                  ? `No Coorwa launch is past ${SOON_AT * 100}% of its graduation target yet.`
                  : "No new Coorwa launches on the curve right now."}{" "}
                Start one on{" "}
                <Link href="/launch" className="text-primary underline underline-offset-4">
                  Launch
                </Link>
                .
              </>
            ) : (
              <>
                No pairs {ticker === ALL ? "listed yet" : `in ${ticker} yet`}. A token appears here
                once its creator picks its pair, which happens at launch.
              </>
            )}
          </div>
        )}
      </div>

      {onCurve && curves.data && (
        <p className="mt-4 text-[12px] text-subtle">
          {curveRows.length} {curveRows.length === 1 ? "launch" : "launches"} still on a curve,
          priced from its reserves · a pair moves to Migrated once its token trades in a real
          pool.
        </p>
      )}

      {!onCurve && data && (
        <p className="mt-4 text-[12px] text-subtle">
          {data.pairs.length} {data.pairs.length === 1 ? "pair" : "pairs"} · COOK at <span className="num">{usd(data.cookPriceUsd)}</span>{" "}
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

function MobileRow({ pair }: { pair: CoorwaPair }) {
  return (
    <li className="border-b border-hair last:border-0">
      <Link
        href={`/terminal/${pair.slug}`}
        className="row-hover flex items-center gap-3 px-4 py-3.5"
      >
        <TokenMark logo={pair.base.logo} symbol={pair.base.symbol} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-primary">
            {pair.base.symbol}
            <span className="text-subtle"> / {pair.quote.ticker}</span>
          </span>
          <span className="block truncate text-[12px] text-subtle">
            Liq <span className="num">{usd(pair.base.liquidityUsd)}</span>
            {pair.base.volume24h ? (
              <>
                {" "}
                · Vol <span className="num">{usd(pair.base.volume24h)}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="num block text-[15px] text-primary">{rwaRatio(pair.price)}</span>
          <span className={`num block text-[12px] ${toneClass(pair.change24h)}`}>
            {pair.change24h == null ? "—" : pct(pair.change24h)}
          </span>
        </span>
      </Link>
    </li>
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

/** A curve's spot price in USD, from its reserves. Null until COOK has a price. */
function curveUsd(pool: CurvePool, cookUsd: number | null): number | null {
  if (!cookUsd) return null;
  const priceCook = curvePrice(pool) * 10 ** (CURVE_TOKEN_DECIMALS - COOK_DECIMALS);
  return priceCook > 0 ? priceCook * cookUsd : null;
}

/** How many shares of the pair's stock one token is worth, when both prices are known. */
function curveRatio(pool: CurvePool, stockUsd: number | null, cookUsd: number | null) {
  const price = curveUsd(pool, cookUsd);
  return price && stockUsd ? price / stockUsd : null;
}

function age(launchTs: number): string {
  const s = Math.max(0, Date.now() / 1000 - launchTs);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Curve pairs are addressed by mint, never by symbol, so a copycat name cannot take the link. */
function curveHref(mint: string, ticker: string) {
  return `/terminal/${mint}-${ticker.toLowerCase()}`;
}

function Progress({ value, migrating }: { value: number; migrating: boolean }) {
  if (migrating) {
    return (
      <span
        className="pill pill-quiet text-[11px]"
        title="Graduated. Its liquidity is moving to a pool, and the pair moves to Migrated once that pool is live."
      >
        Migrating
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-[color:var(--surface-sunken)]">
        <span
          className="block h-full rounded-full bg-[var(--color-cookie)]"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
      <span className="num w-9 text-right text-[12px] text-muted">{Math.floor(value * 100)}%</span>
    </span>
  );
}

function PairTable({
  rows,
  loading,
  unit,
}: {
  rows: CoorwaPair[];
  loading: boolean;
  unit: string;
}) {
  return (
    <>
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
        {loading
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
          : rows.map((p) => <Row key={p.slug} pair={p} />)}
      </tbody>
    </>
  );
}

function CurveTable({
  rows,
  loading,
  unit,
}: {
  rows: CurveListRow[];
  loading: boolean;
  unit: string;
}) {
  return (
    <>
      <thead>
        <tr className="border-b border-hair">
          <Th className="w-[28%]">Pair</Th>
          <Th align="right">Price in {unit}</Th>
          <Th align="right">1 {unit} buys</Th>
          <Th className="w-[18%]">Graduation</Th>
          <Th align="right">Raised</Th>
          <Th align="right">Holders</Th>
          <Th align="right">Age</Th>
          <Th>Curve</Th>
        </tr>
      </thead>
      <tbody>
        {loading
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
          : rows.map((row) => <CurveRow key={row.key} row={row} />)}
      </tbody>
    </>
  );
}

function CurveRow({ row }: { row: CurveListRow }) {
  return (
    <tr className="row-hover border-b border-hair last:border-0">
      <td className="px-4 py-3">
        <Link href={row.href} className="flex items-center gap-3">
          <TokenMark logo={row.logo} symbol={row.symbol} />
          <span className="min-w-0">
            <span className="block truncate text-primary">
              {row.symbol}
              <span className="text-subtle"> / {row.ticker}</span>
            </span>
            <span className="block truncate text-[12px] text-subtle">{row.name}</span>
          </span>
        </Link>
      </td>
      <td className="num px-4 py-3 text-right text-primary">
        {row.ratio ? rwaRatio(row.ratio) : "—"}
      </td>
      <td className="num px-4 py-3 text-right text-muted">
        {row.ratio ? amount(1 / row.ratio) : "—"}
      </td>
      <td className="px-4 py-3">
        <Progress value={row.progress} migrating={row.migrating} />
      </td>
      <td className="num px-4 py-3 text-right text-primary">
        {row.raisedUsd == null ? "—" : usd(row.raisedUsd)}
      </td>
      <td className="num px-4 py-3 text-right text-muted">{row.holders ?? "—"}</td>
      <td className="num px-4 py-3 text-right text-muted">{age(row.startedAt)}</td>
      <td className="px-4 py-3 text-[13px] text-muted">{row.venue}</td>
    </tr>
  );
}

function MobileCurveRow({ row }: { row: CurveListRow }) {
  return (
    <li className="border-b border-hair last:border-0">
      <Link href={row.href} className="row-hover flex items-center gap-3 px-4 py-3.5">
        <TokenMark logo={row.logo} symbol={row.symbol} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-primary">
            {row.symbol}
            <span className="text-subtle"> / {row.ticker}</span>
          </span>
          <span className="mt-1.5 block">
            <Progress value={row.progress} migrating={row.migrating} />
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="num block text-[15px] text-primary">
            {row.ratio ? rwaRatio(row.ratio) : "—"}
          </span>
          <span className="num block text-[12px] text-subtle">{age(row.startedAt)}</span>
        </span>
      </Link>
    </li>
  );
}
