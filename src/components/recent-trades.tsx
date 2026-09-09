"use client";

import useSWR from "swr";
import { usd, amount, timeAgo, shortAddr } from "@/lib/format";
import { cookieTxUrl } from "@/lib/config";
import type { Trade } from "@/lib/candles";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function RecentTrades({
  mint,
  baseSymbol,
  rwaPriceUsd,
  ticker,
}: {
  mint: string;
  baseSymbol: string;
  rwaPriceUsd: number;
  ticker: string;
}) {
  const { data, isLoading } = useSWR<{ trades: Trade[] }>(`/api/trades?mint=${mint}`, fetcher, {
    refreshInterval: 15_000,
    keepPreviousData: true,
  });

  const trades = data?.trades ?? [];

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3.5">
        <span className="label text-[12px]">Recent fills</span>
      </div>
      <div className="max-h-[320px] overflow-y-auto">
        <table className="w-full min-w-[600px] text-[13px]">
          <thead className="sticky top-0 bg-[var(--surface)]">
            <tr>
              <Th>Side</Th>
              <Th align="right">{baseSymbol}</Th>
              <Th align="right">Price in {ticker}</Th>
              <Th align="right">Value</Th>
              <Th align="right">Age</Th>
              <Th align="right">Maker</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading && trades.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-muted">
                  Loading fills
                </td>
              </tr>
            )}
            {!isLoading && trades.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-muted">
                  No fills recorded for this pool yet.
                </td>
              </tr>
            )}
            {trades.map((t) => {
              const inShares = rwaPriceUsd > 0 ? t.price_usd / rwaPriceUsd : null;
              return (
                <tr key={t.id} className="row-hover">
                  <td
                    className="px-5 py-2"
                    style={{ color: t.side === "buy" ? "var(--color-up)" : "var(--color-down)" }}
                  >
                    {t.side}
                  </td>
                  <td className="num px-5 py-2 text-right text-primary">{amount(t.base_amount)}</td>
                  <td className="num px-5 py-2 text-right text-muted">
                    {inShares == null
                      ? "—"
                      : inShares >= 0.0001
                        ? inShares.toFixed(8)
                        : inShares.toExponential(3)}
                  </td>
                  <td className="num px-5 py-2 text-right text-primary">{usd(t.value_usd)}</td>
                  <td className="num px-5 py-2 text-right text-muted">{timeAgo(t.ts)}</td>
                  <td className="px-5 py-2 text-right">
                    <a
                      href={cookieTxUrl(t.tx)}
                      target="_blank"
                      rel="noreferrer"
                      className="num text-muted transition-colors hover:text-[color:var(--text-primary)]"
                    >
                      {shortAddr(t.maker, 4)}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`label whitespace-nowrap px-5 pb-2 text-[12px] font-normal ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
