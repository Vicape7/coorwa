"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usd, shortAddr } from "@/lib/format";
import { HOLDER_MIN_USD, PAYOUT_MIN_USD, solanaTxUrl } from "@/lib/config";
import type { RewardsSummary } from "@/lib/rewards";
import { TokenMark } from "./token-mark";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type Role = "holder" | "creator";

/** One token this wallet has something coming from, in the role the tab shows. */
interface MyLine {
  mint: string;
  token: string;
  ticker: string | null;
  nextUsd: number;
  detail: string;
}

export function RewardsView() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const wallet = publicKey?.toBase58();
  const [tab, setTab] = useState<Role>("holder");

  const { data } = useSWR<RewardsSummary>(
    wallet ? `/api/rewards?wallet=${wallet}` : "/api/rewards",
    fetcher,
    { refreshInterval: 30_000 },
  );

  const isCreator = !!wallet && (data?.created?.length ?? 0) > 0;
  const role: Role = isCreator ? tab : "holder";

  // Payout history names its token by mint; every list the summary carries can put a symbol on it.
  const symbolOf = new Map<string, string>();
  for (const p of [...(data?.pools ?? []), ...(data?.created ?? []), ...(data?.estimates ?? [])]) {
    if (p.symbol) symbolOf.set(p.mint, p.symbol);
  }
  const tokenName = (mint: string) => symbolOf.get(mint) ?? shortAddr(mint, 4);
  const tokenCell = (mint: string, size = 24) => (
    <span key={mint} className="inline-flex items-center gap-2.5">
      <TokenMark logo={data?.logos?.[mint] ?? null} symbol={tokenName(mint)} size={size} />
      {tokenName(mint)}
    </span>
  );

  // A creator is paid for what they hold, like anyone else, so their own line on a token they
  // made is the holder estimate for it. The tab is a different list, never a different share.
  const estimateOf = new Map((data?.estimates ?? []).map((e) => [e.mint, e]));
  const lines: MyLine[] =
    role === "holder"
      ? (data?.estimates ?? []).map((e) => ({
          mint: e.mint,
          token: tokenName(e.mint),
          ticker: e.ticker,
          nextUsd: e.estimatedUsd,
          detail: `your share ${(e.share * 100).toFixed(2)}% of ${usd(e.waitingUsd)}`,
        }))
      : (data?.created ?? []).map((p) => ({
          mint: p.mint,
          token: tokenName(p.mint),
          ticker: p.ticker,
          nextUsd: estimateOf.get(p.mint)?.estimatedUsd ?? 0,
          detail: `${usd(p.holdersWaitingUsd)} to its holders, ${usd(p.holdersAccruedUsd)} earned so far`,
        }));
  lines.sort((a, b) => b.nextUsd - a.nextUsd);

  const nextUsd = lines.reduce((sum, l) => sum + l.nextUsd, 0);
  const paid = data?.paid ?? [];
  const paidUsd = paid.reduce((sum, p) => sum + p.usd, 0);
  const pendingUsd = (data?.pending ?? []).reduce((sum, p) => sum + p.usd, 0);

  const nextRun = data?.nextRunAt ? new Date(data.nextRunAt) : null;

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Rewards</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Your rewards
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Paid once a day in each token&apos;s stock, to your same address on Solana. Nothing to
          claim.
        </p>
      </div>

      <div className="card mt-10 p-7 sm:p-8">
        {isCreator && (
          <div className="segmented mb-6 w-full sm:w-auto">
            <button onClick={() => setTab("holder")} data-active={role === "holder"}>
              As a holder
            </button>
            <button onClick={() => setTab("creator")} data-active={role === "creator"}>
              Your launches
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="title text-primary">
            {role === "holder" ? "Your rewards as a holder" : "The tokens you launched"}
          </h2>
          {nextRun && (
            <span className="text-[13px] text-muted">
              Next payout {untilText(nextRun)} · {nextRun.toLocaleString()}
            </span>
          )}
        </div>

        {!wallet ? (
          <div className="mt-4 flex flex-wrap items-center gap-5">
            <p className="text-[14px] text-muted">Connect to see what is coming to you.</p>
            <button className="btn btn-primary ml-auto" onClick={() => setVisible(true)}>
              Connect wallet
            </button>
          </div>
        ) : !data ? (
          <div className="skeleton mt-5 h-24 w-full" />
        ) : !data.configured ? (
          <p className="mt-4 text-[14px] text-muted">
            Rewards need a database. Set <span className="num text-primary">DATABASE_URL</span> to
            enable this page.
          </p>
        ) : (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <Figure
                label="Next payout"
                value={usd(nextUsd)}
                sub={
                  role === "holder"
                    ? "Estimated, from today so far"
                    : "What you hold of your own tokens"
                }
                emphasis
              />
              <Figure label="Paid to you" value={usd(paidUsd)} sub="Already on Solana" />
              <Figure
                label="Carried over"
                value={usd(pendingUsd)}
                sub={`Sent once it reaches ${plain(PAYOUT_MIN_USD)} in one stock`}
              />
            </div>

            {lines.length > 0 ? (
              <ul className="mt-6 divide-y divide-[color:var(--divider)] border-t border-hair">
                {lines.map((l) => (
                  <li key={l.mint} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3.5">
                    <span className="min-w-[72px] text-[15px] text-primary">
                      {tokenCell(l.mint, 32)}
                    </span>
                    {l.ticker ? (
                      <span className="text-[13px] text-muted">paid in {l.ticker}x</span>
                    ) : (
                      <span className="text-[13px] text-muted">no pair to pay in</span>
                    )}
                    <span className="ml-auto text-right">
                      <span className="num block text-[15px] text-primary">{usd(l.nextUsd)}</span>
                      <span className="num block text-[12px] text-subtle">{l.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-6 border-t border-hair pt-5 text-[14px] leading-relaxed text-muted">
                Nothing coming yet. Hold at least {plain(HOLDER_MIN_USD)} of a{" "}
                <Link href="/terminal" className="text-primary underline underline-offset-4">
                  token on Coorwa
                </Link>{" "}
                that people trade, and your share shows up here.
              </p>
            )}

            {paid.length > 0 && (
              <div className="mt-8">
                <h3 className="text-[15px] text-primary">Payouts to you</h3>
                <SimpleTable
                  head={["When", "Token", "Paid in", "Value", "Transaction"]}
                  rows={paid.map((p) => [
                    new Date(p.at).toLocaleDateString(),
                    tokenCell(p.mint),
                    `${p.ticker}x`,
                    usd(p.usd),
                    p.signature ? (
                      <a
                        key={p.signature}
                        href={solanaTxUrl(p.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-[color:var(--divider-strong)] underline-offset-4"
                      >
                        {shortAddr(p.signature, 5)}
                      </a>
                    ) : (
                      "-"
                    ),
                  ])}
                />
              </div>
            )}
          </>
        )}
      </div>

      <div className="card mt-4 p-7 sm:p-8">
        <h2 className="title text-primary">Every token</h2>
        <p className="mt-1.5 text-[13px] text-muted">
          What each token&apos;s holders get at the next payout, and what they have been paid.
        </p>
        {!data?.pools?.length ? (
          <p className="mt-4 text-[14px] text-muted">No fees earned on any token yet.</p>
        ) : (
          <SimpleTable
            head={["Token", "Paid in", "Next payout", "Paid so far"]}
            rows={data.pools.map((p) => [
              tokenCell(p.mint, 28),
              p.ticker ? `${p.ticker}x` : "no pair yet",
              usd(p.holdersWaitingUsd),
              usd(p.holdersPaidUsd),
            ])}
          />
        )}
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub: string;
  emphasis?: boolean;
}) {
  return (
    <div className="panel p-5">
      <div className="label text-[12px]">{label}</div>
      <div className={`num display mt-2 text-primary ${emphasis ? "text-[34px]" : "text-[26px]"}`}>
        {value}
      </div>
      <div className="mt-1 text-[13px] text-muted">{sub}</div>
    </div>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      {/* Four columns fit a phone as they are; wider tables keep their width and scroll sideways. */}
      <table
        className={`w-full text-[13px] sm:text-[14px] ${head.length > 4 ? "min-w-[480px]" : ""}`}
      >
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                className={`label whitespace-nowrap py-2 pl-3 text-[12px] font-normal first:pl-0 ${
                  i === 0 ? "text-left" : "text-right"
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="row-hover">
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={`num py-2.5 pl-3 first:pl-0 ${j === 0 ? "text-left text-primary" : "text-right text-muted"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "in 5 h", "in 40 min", or "any moment now" once it is due. */
function untilText(at: Date): string {
  const min = Math.round((at.getTime() - Date.now()) / 60_000);
  if (min <= 0) return "any moment now";
  if (min < 60) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

/** A round figure in the copy: $5, $1. `usd` would print $5.00. */
function plain(n: number): string {
  return `$${Number(n.toFixed(3))}`;
}
