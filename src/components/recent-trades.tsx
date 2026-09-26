"use client";

import { useState } from "react";
import useSWR from "swr";
import { usd, amount, timeAgo, shortAddr, tinyNumber } from "@/lib/format";
import { cookieTxUrl } from "@/lib/config";
import type { Trade } from "@/lib/candles";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

/** Fills on one page of the list. */
const PAGE = 10;

/**
 * The fills of a pair as a list: the side as an arrow, the size over the
 * wallet, the price in shares over the dollar value, and the age. Each row opens its transaction.
 * It draws no card of its own; it sits in the activity card under the chart.
 */
export function RecentTrades({
  mint,
  baseSymbol,
  rwaPriceUsd,
  ticker,
  pool,
  venue,
}: {
  mint: string;
  baseSymbol: string;
  rwaPriceUsd: number;
  ticker: string;
  /** A curve, for a token whose fills are not in the pool feed yet. */
  pool?: string;
  venue?: "momoswap" | "coorwa";
}) {
  const { data, isLoading } = useSWR<{ trades: Trade[] }>(
    `/api/trades?mint=${mint}${pool ? `&pool=${pool}` : ""}${venue ? `&venue=${venue}` : ""}`,
    fetcher,
    { refreshInterval: 15_000, keepPreviousData: true },
  );
  const [page, setPage] = useState(0);

  const trades = data?.trades ?? [];
  const pages = Math.max(1, Math.ceil(trades.length / PAGE));
  // A refresh can shorten the list under the page being read.
  const current = Math.min(page, pages - 1);
  const shown = trades.slice(current * PAGE, current * PAGE + PAGE);

  if (trades.length === 0) {
    return (
      <div className="py-10 text-center text-[13px] text-muted">
        {isLoading ? "Loading fills" : "No fills recorded for this pool yet."}
      </div>
    );
  }

  return (
    <div>
      <ul>
        {shown.map((t) => {
          const inShares = rwaPriceUsd > 0 ? t.price_usd / rwaPriceUsd : null;
          const buy = t.side === "buy";
          return (
            <li key={t.id}>
              <a
                href={cookieTxUrl(t.tx)}
                target="_blank"
                rel="noreferrer"
                className="row-hover grid grid-cols-[20px_minmax(0,1fr)_auto_40px] items-center gap-3 rounded-[var(--radius-panel)] px-2 py-2.5 sm:px-3"
              >
                <SideArrow buy={buy} />
                <div className="min-w-0">
                  <div className="num truncate text-[13px] text-primary">
                    {amount(t.base_amount)} {baseSymbol}
                  </div>
                  <div className="num truncate text-[12px] text-subtle">{shortAddr(t.maker, 4)}</div>
                </div>
                <div className="text-right">
                  <div className="num text-[13px] text-primary">
                    {inShares ? tinyNumber(inShares, 4, false) : "—"}{" "}
                    <span className="text-subtle">{ticker}</span>
                  </div>
                  <div className="num text-[12px] text-subtle">{usd(t.value_usd)}</div>
                </div>
                <div className="num text-right text-[12px] text-subtle">{timeAgo(t.ts)}</div>
              </a>
            </li>
          );
        })}
      </ul>

      {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} />}
    </div>
  );
}

/** Up and to the right for a buy, down and to the left for a sell, in the pair's colours. */
function SideArrow({ buy }: { buy: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      role="img"
      aria-label={buy ? "buy" : "sell"}
      style={{ color: buy ? "var(--color-up)" : "var(--color-down)" }}
    >
      <path
        d={buy ? "M4.5 11.5 11.5 4.5M6 4.5h5.5V10" : "M11.5 4.5 4.5 11.5M10 11.5H4.5V6"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Page numbers, the first and last always there and the ones near the current page between. */
function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  const numbers: (number | "gap")[] = [];
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 1) numbers.push(i);
    else if (numbers[numbers.length - 1] !== "gap") numbers.push("gap");
  }
  const arrow =
    "grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:text-[color:var(--text-primary)] disabled:opacity-30";
  return (
    <div className="mt-3 flex items-center justify-center gap-2">
      <button className={arrow} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Newer fills">
        <Chevron left />
      </button>
      <div className="segmented">
        {numbers.map((n, i) =>
          n === "gap" ? (
            <span key={`gap-${i}`} className="px-2 py-2 text-[13px] text-subtle">
              …
            </span>
          ) : (
            <button key={n} className="num" data-active={n === page} onClick={() => onPage(n)}>
              {n + 1}
            </button>
          ),
        )}
      </div>
      <button className={arrow} disabled={page === pages - 1} onClick={() => onPage(page + 1)} aria-label="Older fills">
        <Chevron />
      </button>
    </div>
  );
}

function Chevron({ left = false }: { left?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
      <path
        d={left ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
