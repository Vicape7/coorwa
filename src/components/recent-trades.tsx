"use client";

import useSWR from "swr";
import { usd, amount, timeAgo, shortAddr, tinyNumber } from "@/lib/format";
import { cookieTxUrl } from "@/lib/config";
import type { Trade } from "@/lib/candles";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

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

  const trades = data?.trades ?? [];

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3.5">
        <span className="label text-[12px]">Recent fills</span>
      </div>
      <div className="max-h-[320px] overflow-y-auto">
        <table className="w-full text-[13px] sm:min-w-[600px]">
          <thead className="sticky top-0 bg-[var(--surface)]">
            <tr>
              <Th>Side</Th>
              <Th align="right">{baseSymbol}</Th>
              <Th align="right" wide>
                Price in {ticker}
              </Th>
              <Th align="right">Value</Th>
              <Th align="right">Age</Th>
              <Th align="right" wide>
                Maker
              </Th>
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
                    className="px-3 py-2 sm:px-5"
                    style={{ color: t.side === "buy" ? "var(--color-up)" : "var(--color-down)" }}
                  >
                    {t.side}
                  </td>
                  <td className="num px-3 py-2 text-right text-primary sm:px-5">
                    {amount(t.base_amount)}
                  </td>
                  <td className="num hidden px-5 py-2 text-right text-muted sm:table-cell">
                    {inShares ? tinyNumber(inShares, 4, false) : "—"}
                  </td>
                  <td className="num px-3 py-2 text-right text-primary sm:px-5">{usd(t.value_usd)}</td>
                  <td className="num px-3 py-2 text-right text-muted sm:px-5">{timeAgo(t.ts)}</td>
                  <td className="hidden px-5 py-2 text-right sm:table-cell">
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

/** `wide` columns only show from sm up; a phone keeps side, size, value and age. */
function Th({
  children,
  align = "left",
  wide = false,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  wide?: boolean;
}) {
  return (
    <th
      className={`label whitespace-nowrap px-3 pb-2 text-[12px] font-normal sm:px-5 ${
        align === "right" ? "text-right" : "text-left"
      } ${wide ? "hidden sm:table-cell" : ""}`}
    >
      {children}
    </th>
  );
}
