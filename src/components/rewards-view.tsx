"use client";

import Link from "next/link";
import useSWR from "swr";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usd, shortAddr } from "@/lib/format";
import {
  CASHBACK_SPLIT,
  COORWA_SWAP_FEE_BPS,
  HOLDER_MIN_USD,
  PAIR_LISTING_USD,
  PAYOUT_MIN_USD,
  cookieAccountUrl,
  cookieTxUrl,
  solanaTxUrl,
} from "@/lib/config";
import type { CashbackSummary } from "@/lib/cashback";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function RewardsView() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const wallet = publicKey?.toBase58();

  const { data } = useSWR<CashbackSummary>(
    wallet ? `/api/rewards?wallet=${wallet}` : "/api/rewards",
    fetcher,
    { refreshInterval: 30_000 },
  );

  const pendingUsd = data?.pending.reduce((sum, p) => sum + p.usd, 0) ?? 0;
  const paidUsd = data?.paid.reduce((sum, p) => sum + p.usd, 0) ?? 0;
  const estimatedUsd = data?.estimates.reduce((sum, e) => sum + e.estimatedUsd, 0) ?? 0;
  const paidToHolders = data?.pools.reduce((sum, p) => sum + p.holdersPaidUsd, 0) ?? 0;
  const waiting = data?.pools.reduce((sum, p) => sum + p.holdersWaitingUsd, 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Rewards</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Hold a token, get paid in its stock.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Every token on Coorwa is paired with a stock, and the fees it earns are paid out once a day
          to the wallets holding it, in that stock, straight to the same address on Solana. There is
          nothing to claim. {pct(CASHBACK_SPLIT.holders)} goes to holders and{" "}
          {pct(CASHBACK_SPLIT.creator)} to the token&apos;s creator, paid the same way.
        </p>
      </div>

      {/* Platform totals, before anything wallet-specific. */}
      <div className="card mt-10 grid gap-8 p-8 sm:grid-cols-3">
        <Figure label="Paid to holders" value={usd(paidToHolders)} sub="Across every token" />
        <Figure label="Waiting to distribute" value={usd(waiting)} sub="Shared out at the next run" />
        <Figure
          label="Next run"
          value={data?.nextRunAt ? new Date(data.nextRunAt).toLocaleString() : "-"}
          sub={data?.nextRunAt ? "A day after the first holder snapshot" : "Starts after the next fee"}
        />
      </div>

      {/* This wallet */}
      <div className="card mt-4 p-8">
        {!wallet ? (
          <div className="flex flex-wrap items-center gap-5">
            <div>
              <div className="text-[15px] text-primary">Your rewards</div>
              <p className="mt-1 text-[14px] text-muted">
                Connect to see what you have been paid as a holder and as a creator.
              </p>
            </div>
            <button className="btn btn-primary ml-auto" onClick={() => setVisible(true)}>
              Connect wallet
            </button>
          </div>
        ) : !data ? (
          <div className="skeleton h-24 w-full" />
        ) : !data.configured ? (
          <div>
            <div className="text-[15px] text-primary">Accounting is not configured here</div>
            <p className="mt-2 max-w-2xl text-[14px] leading-[1.7] text-muted">
              Rewards need history, so they need a database. Set{" "}
              <span className="num text-primary">DATABASE_URL</span> to enable this page.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-8 sm:grid-cols-3">
              <Figure label="Paid to you" value={usd(paidUsd)} sub="Sent to your wallet on Solana" emphasis />
              <Figure
                label="Owed, under the minimum"
                value={usd(pendingUsd)}
                sub={`Sent once it reaches ${usd(PAYOUT_MIN_USD)} in one stock`}
              />
              <Figure
                label="Next run, estimated"
                value={usd(estimatedUsd)}
                sub="From the holder snapshots so far"
              />
            </div>

            {data.estimates.length > 0 && (
              <Table
                title="Your share of what is waiting"
                note="An estimate. Snapshots are taken at random moments through the day, so holding the whole time is what keeps your share."
                head={["Token", "Paid in", "Waiting", "Your share", "About"]}
                rows={data.estimates.map((e) => [
                  e.symbol ?? shortAddr(e.mint, 4),
                  e.ticker,
                  usd(e.waitingUsd),
                  `${(e.share * 100).toFixed(2)}%`,
                  usd(e.estimatedUsd),
                ])}
              />
            )}

            {data.paid.length > 0 ? (
              <Table
                title="Payouts to you"
                head={["When", "Stock", "As", "Value", "Transaction"]}
                rows={data.paid.map((p) => [
                  new Date(p.at).toLocaleDateString(),
                  p.ticker,
                  p.role,
                  usd(p.usd),
                  p.signature ? (
                    <a
                      key={p.signature}
                      href={solanaTxUrl(p.signature)}
                      target="_blank"
                      rel="noreferrer"
                      className="num underline decoration-[color:var(--divider-strong)] underline-offset-4"
                    >
                      {shortAddr(p.signature, 5)}
                    </a>
                  ) : (
                    "-"
                  ),
                ])}
              />
            ) : (
              <p className="mt-6 border-t border-hair pt-5 text-[14px] leading-relaxed text-muted">
                Nothing sent to you yet. Hold at least {usd(HOLDER_MIN_USD)} of a{" "}
                <Link href="/terminal" className="text-primary underline underline-offset-4">
                  token on Coorwa
                </Link>{" "}
                and your share arrives in its stock after the next run.
              </p>
            )}
          </>
        )}
      </div>

      {/* Tokens */}
      <div className="card mt-4 overflow-hidden">
        <div className="px-6 pt-6">
          <h2 className="title text-primary">Holder rewards by token</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Waiting is shared out at the next run over whoever held the token through the day. A token
            without a pair keeps its rewards until its creator picks one.
          </p>
        </div>
        {!data?.pools?.length ? (
          <p className="px-6 pb-6 pt-4 text-[14px] text-muted">No fees earned on any token yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-[14px]">
              <thead>
                <tr>
                  <Th>Token</Th>
                  <Th>Paid in</Th>
                  <Th align="right">Waiting</Th>
                  <Th align="right">Paid to holders</Th>
                </tr>
              </thead>
              <tbody>
                {data.pools.map((p) => (
                  <tr key={p.mint} className="row-hover">
                    <td className="px-6 py-2.5 text-primary">{p.symbol ?? shortAddr(p.mint, 4)}</td>
                    <td className="num px-6 py-2.5 text-muted">{p.ticker ?? "no pair yet"}</td>
                    <td className="num px-6 py-2.5 text-right text-primary">
                      {usd(p.holdersWaitingUsd)}
                    </td>
                    <td className="num px-6 py-2.5 text-right text-muted">{usd(p.holdersPaidUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Runs, so every payout can be checked */}
      <div className="card mt-4 overflow-hidden">
        <div className="px-6 pt-6">
          <h2 className="title text-primary">Payout runs</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Each run bridges the day&apos;s fees from{" "}
            {data?.operator ? (
              <a
                href={cookieAccountUrl(data.operator)}
                target="_blank"
                rel="noreferrer"
                className="num underline underline-offset-4"
              >
                {shortAddr(data.operator, 5)}
              </a>
            ) : (
              "the operator wallet"
            )}{" "}
            to Solana, buys each stock on Jupiter and sends it out. Its network costs come out of the
            pot and are shown here.
          </p>
        </div>
        {!data?.runs?.length ? (
          <p className="px-6 pb-6 pt-4 text-[14px] text-muted">No runs yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[14px]">
              <thead>
                <tr>
                  <Th>Run</Th>
                  <Th>State</Th>
                  <Th align="right">Paid</Th>
                  <Th align="right">Wallets</Th>
                  <Th align="right">Costs</Th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id} className="row-hover">
                    <td className="num px-6 py-2.5 text-primary">
                      {r.bridgeSignature ? (
                        <a
                          href={cookieTxUrl(r.bridgeSignature)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-[color:var(--divider-strong)] underline-offset-4"
                        >
                          {new Date(r.asOf).toLocaleDateString()}
                        </a>
                      ) : (
                        new Date(r.asOf).toLocaleDateString()
                      )}
                    </td>
                    <td className="px-6 py-2.5 text-[13px] text-muted" title={r.note ?? undefined}>
                      {r.status}
                    </td>
                    <td className="num px-6 py-2.5 text-right text-primary">{usd(r.totalUsd)}</td>
                    <td className="num px-6 py-2.5 text-right text-muted">{r.wallets}</td>
                    <td className="num px-6 py-2.5 text-right text-muted">
                      {r.costsUsd == null ? "-" : usd(r.costsUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Where it comes from */}
      <div className="card mt-4 p-8">
        <h2 className="title text-primary">Where rewards come from</h2>
        <dl className="mt-6 divide-y divide-[color:var(--divider)]">
          <Source
            label="Launchpad fills"
            state="Free to you"
            tone="up"
            body="Every buy Coorwa routes on a MomoSwap curve names Coorwa as referrer, which pays 20% of the 1% trade fee. MomoSwap pays that out of the same fee whether or not anyone is named, so it costs the trader nothing."
          />
          <Source
            label="Swap fills"
            state={`${(COORWA_SWAP_FEE_BPS / 100).toFixed(2)}% fee`}
            tone="muted"
            body="Neither Cookie Chain router pays a referrer, so Coorwa charges its own fee on a terminal swap. It is a fee: it comes out of the trade and is shown before signing. A trader who also holds the token gets part of it back as a holder."
          />
          <Source
            label="Pairs"
            state="To the token's holders"
            tone="up"
            body={`A token from outside Coorwa gets its one pair when its creator pays $${PAIR_LISTING_USD}. All of it goes to the token's holders.`}
          />
          <Source
            label="LP fees"
            state="Yours already"
            tone="muted"
            body="Fees on a position you own are paid to you by the pool directly, and Coorwa takes nothing from them."
          />
        </dl>
        <p className="mt-6 text-[13px] leading-relaxed text-muted">
          Fees reach the operator wallet and wait there until the day&apos;s run pays them out, the same
          way StonkFun pays its holders. A wallet needs at least {usd(HOLDER_MIN_USD)} of a token to
          count, and pool vaults and programs never do.
        </p>
      </div>
    </div>
  );
}

function Table({
  title,
  note,
  head,
  rows,
}: {
  title: string;
  note?: string;
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="mt-8 border-t border-hair pt-6">
      <div className="label text-[12px]">{title}</div>
      {note && <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{note}</p>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[480px] text-[14px]">
          <thead>
            <tr>
              {head.map((h, i) => (
                <Th key={h} align={i === 0 ? "left" : "right"} flush>
                  {h}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="row-hover">
                {r.map((cell, j) => (
                  <td
                    key={j}
                    className={`num py-2 ${j === 0 ? "text-left text-primary" : "text-right text-muted"}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
    <div>
      <div className="label text-[12px]">{label}</div>
      <div className={`num display mt-2 text-primary ${emphasis ? "text-[40px]" : "text-[28px]"}`}>
        {value}
      </div>
      <div className="mt-1.5 text-[13px] text-muted">{sub}</div>
    </div>
  );
}

function Source({
  label,
  state,
  tone,
  body,
}: {
  label: string;
  state: string;
  tone: "up" | "muted";
  body: string;
}) {
  return (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:gap-6">
      <div className="w-44 shrink-0">
        <dt className="text-[14px] text-primary">{label}</dt>
        <span
          className="pill mt-1.5"
          style={
            tone === "up"
              ? {
                  background: "color-mix(in srgb, var(--color-up) 12%, transparent)",
                  color: "var(--color-up)",
                }
              : { background: "var(--surface-raised)", color: "var(--text-muted)" }
          }
        >
          {state}
        </span>
      </div>
      <dd className="text-[14px] leading-[1.7] text-muted">{body}</dd>
    </div>
  );
}

function pct(share: number): string {
  return `${Number((share * 100).toFixed(1))}%`;
}

function Th({
  children,
  align = "left",
  flush,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  flush?: boolean;
}) {
  return (
    <th
      className={`label whitespace-nowrap py-2 text-[12px] font-normal ${flush ? "" : "px-6"} ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
