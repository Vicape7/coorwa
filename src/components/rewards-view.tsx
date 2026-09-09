"use client";

import useSWR from "swr";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usd, shortAddr, timeAgo } from "@/lib/format";
import { cookieTxUrl, CASHBACK_SPLIT } from "@/lib/config";
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

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Cashback</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          The fees you generate, returned.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Corwa rebates the fees it earns rather than keeping them. Today that means the launchpad
          referral share: MomoSwap pays a referrer 20% of its 1% curve fee, out of the same fee
          either way - with nobody named, the programme keeps that slice itself. So naming Corwa
          costs a trader nothing and is what funds the rebate.
        </p>
      </div>

      {/* Balance */}
      <div className="card mt-10 p-8">
        {!wallet ? (
          <div className="flex flex-wrap items-center gap-5">
            <div>
              <div className="text-[15px] text-primary">Your cashback</div>
              <p className="mt-1 text-[14px] text-muted">
                Connect to see what you have accrued as a trader and as a creator.
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
              Cashback needs history, so it needs a database. Trading, launching and providing
              liquidity are entirely on-chain and work without one - this page is the only part that
              does not. Set <span className="num text-primary">DATABASE_URL</span> to enable it.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-8 sm:grid-cols-3">
              <Figure
                label="Claimable"
                value={usd(data.claimableUsd)}
                sub="Trader plus creator share, net of payouts"
                emphasis
              />
              <Figure
                label="As a trader"
                value={usd(data.traderAccruedUsd)}
                sub={`${Math.round(CASHBACK_SPLIT.trader * 100)}% of fees you generated`}
              />
              <Figure
                label="As a creator"
                value={usd(data.creatorAccruedUsd)}
                sub={`${Math.round(CASHBACK_SPLIT.creator * 100)}% of fees on tokens you launched`}
              />
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-hair pt-6">
              <div className="text-[13px] text-muted">
                <span className="num text-primary">{data.fillCount}</span> fills ·{" "}
                <span className="num text-primary">{usd(data.volumeUsd)}</span> routed
              </div>
              <button className="btn btn-primary ml-auto" disabled title="Claiming opens once the rebate treasury is funded for this deployment.">
                Claim
              </button>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-subtle">
              Accrual is live and verifiable - every row below is a confirmed transaction, checked
              against the chain before it was counted. Claiming stays closed until the rebate
              treasury is funded on this deployment, so the button tells you the truth rather than
              failing after you press it.
            </p>
          </>
        )}
      </div>

      {/* History */}
      {data?.configured && wallet && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4">
            <h2 className="title text-primary">Your fills</h2>
          </div>
          {data.recent.length === 0 ? (
            <p className="px-6 pb-6 text-[14px] text-muted">
              Nothing routed through Corwa from this wallet yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-[14px]">
                <thead>
                  <tr>
                    <Th>Token</Th>
                    <Th>Side</Th>
                    <Th align="right">Value</Th>
                    <Th align="right">Fee earned</Th>
                    <Th align="right">Your share</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.signature} className="row-hover">
                      <td className="px-6 py-2.5">
                        <a
                          href={cookieTxUrl(r.signature)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline decoration-[color:var(--divider-strong)] underline-offset-4"
                        >
                          {r.symbol ?? shortAddr(r.signature, 4)}
                        </a>
                      </td>
                      <td
                        className="px-6 py-2.5"
                        style={{ color: r.side === "buy" ? "var(--color-up)" : "var(--color-down)" }}
                      >
                        {r.side}
                      </td>
                      <td className="num px-6 py-2.5 text-right text-primary">{usd(r.valueUsd)}</td>
                      <td className="num px-6 py-2.5 text-right text-muted">{usd(r.feeUsd)}</td>
                      <td className="num px-6 py-2.5 text-right text-primary">
                        {usd(r.feeUsd * CASHBACK_SPLIT.trader)}
                      </td>
                      <td className="num px-6 py-2.5 text-right text-muted">
                        {timeAgo(new Date(r.createdAt).getTime())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Where it comes from */}
      <div className="card mt-4 p-8">
        <h2 className="title text-primary">Where cashback comes from today</h2>
        <dl className="mt-6 divide-y divide-[color:var(--divider)]">
          <Source
            label="Launchpad fills"
            state="Live"
            tone="up"
            body="Every buy Corwa routes on a MomoSwap curve names Corwa as referrer, which pays 20% of the 1% trade fee. That is real revenue and it is what the balance above is built from."
          />
          <Source
            label="Swap fills"
            state="No fee yet"
            tone="muted"
            body="Neither Cookie Chain router - Cookiebox or Candy Shop - exposes a platform-fee or referral parameter, so a swap routed through Corwa earns Corwa nothing. Those fills are recorded at zero rather than credited with a rebate no fee is backing. When a router adds one, this turns on with no change to how you trade."
          />
          <Source
            label="LP fees"
            state="Yours already"
            tone="muted"
            body="Fees on a position you own are paid to you by the pool directly. Corwa never sits between you and them - it just builds the claim."
          />
        </dl>
      </div>

      {/* Split + leaderboard */}
      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        <div className="card p-8">
          <h2 className="title text-primary">How a fee is split</h2>
          <dl className="mt-6 space-y-4">
            <Split
              pct={CASHBACK_SPLIT.trader}
              label="Trader"
              body="Back to whoever generated the fee, claimable in COOK."
            />
            <Split
              pct={CASHBACK_SPLIT.creator}
              label="Creator"
              body="To whoever launched the token being traded, on top of MomoSwap's own creator fee."
            />
            <Split
              pct={CASHBACK_SPLIT.liquidity}
              label="Liquidity"
              body="Returned to the pool, so the pairs get deeper rather than thinner."
            />
          </dl>
        </div>

        <div className="card p-8">
          <h2 className="title text-primary">Most routed</h2>
          {!data?.leaderboard?.length ? (
            <p className="mt-4 text-[14px] text-muted">No volume routed yet.</p>
          ) : (
            <ol className="mt-6 space-y-3">
              {data.leaderboard.map((row, i) => (
                <li key={row.wallet} className="flex items-center gap-4">
                  <span className="num w-5 shrink-0 text-[13px] text-subtle">{i + 1}</span>
                  <span className="num flex-1 truncate text-[14px] text-primary">
                    {shortAddr(row.wallet, 5)}
                  </span>
                  <span className="num text-[14px] text-muted">{usd(row.volumeUsd)}</span>
                  <span className="num w-20 shrink-0 text-right text-[14px] text-primary">
                    {usd(row.accruedUsd)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
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
      <div
        className={`num display mt-2 text-primary ${emphasis ? "text-[44px]" : "text-[32px]"}`}
      >
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

function Split({ pct, label, body }: { pct: number; label: string; body: string }) {
  return (
    <div className="flex items-baseline gap-5">
      <dt className="num display w-16 shrink-0 text-[28px] text-primary">
        {Math.round(pct * 100)}
        <span className="text-[16px] text-subtle">%</span>
      </dt>
      <dd>
        <div className="text-[14px] text-primary">{label}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-muted">{body}</div>
      </dd>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`label whitespace-nowrap px-6 py-2 text-[12px] font-normal ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
