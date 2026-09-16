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

/** The worked example on the page: this much traded on one token. */
const EXAMPLE_VOLUME_USD = 100;

/**
 * One line per token this wallet has something coming from, as a holder or as its creator. The page
 * used to show these as two tables with different columns; one list reads faster.
 */
interface MyLine {
  key: string;
  token: string;
  ticker: string | null;
  role: "Holder" | "Creator";
  nextUsd: number;
  detail: string;
}

export function RewardsView() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const wallet = publicKey?.toBase58();

  const { data } = useSWR<CashbackSummary>(
    wallet ? `/api/rewards?wallet=${wallet}` : "/api/rewards",
    fetcher,
    { refreshInterval: 30_000 },
  );

  const feePct = COORWA_SWAP_FEE_BPS / 100;
  const exampleFee = (EXAMPLE_VOLUME_USD * COORWA_SWAP_FEE_BPS) / 10_000;

  const paidUsd = data?.paid.reduce((sum, p) => sum + p.usd, 0) ?? 0;
  const pendingUsd = data?.pending.reduce((sum, p) => sum + p.usd, 0) ?? 0;

  const lines: MyLine[] = [
    ...(data?.estimates ?? []).map((e) => ({
      key: `h:${e.mint}`,
      token: e.symbol ?? shortAddr(e.mint, 4),
      ticker: e.ticker,
      role: "Holder" as const,
      nextUsd: e.estimatedUsd,
      detail: `${(e.share * 100).toFixed(2)}% of ${usd(e.waitingUsd)}`,
    })),
    ...(data?.created ?? []).map((p) => ({
      key: `c:${p.mint}`,
      token: p.symbol ?? shortAddr(p.mint, 4),
      ticker: p.ticker,
      role: "Creator" as const,
      nextUsd: Math.max(0, p.creatorAccruedUsd - p.creatorAllocatedUsd),
      detail: `${usd(p.creatorAccruedUsd)} earned, ${usd(p.creatorPaidUsd)} paid`,
    })),
  ].sort((a, b) => b.nextUsd - a.nextUsd);
  const nextUsd = lines.reduce((sum, l) => sum + l.nextUsd, 0);

  const nextRun = data?.nextRunAt ? new Date(data.nextRunAt) : null;

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      {/* Header */}
      <div className="max-w-2xl">
        <span className="label text-[12px]">Rewards</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Hold a token, get paid in its stock.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Fees from a token go to that token&apos;s holders and its creator, once a day, in the
          token&apos;s stock. Nothing to claim.
        </p>
      </div>

      {/* How it works */}
      <div className="mt-10 grid gap-3 md:grid-cols-3">
        <Step
          n={1}
          title="A token is traded"
          body={`Every swap on Coorwa pays a ${feePct}% fee. The fee belongs to the token that was traded, and to no other token.`}
        />
        <Step
          n={2}
          title="The fee is split"
          body={`${pct(CASHBACK_SPLIT.holders)} to wallets holding at least ${plain(HOLDER_MIN_USD)} of that token, by how much they hold through the day. ${pct(CASHBACK_SPLIT.creator)} to its creator.`}
        />
        <Step
          n={3}
          title="Paid once a day"
          body="In the token's pair stock, for example NVDAx, sent to your same address on Solana. Coorwa keeps nothing."
        />
      </div>

      <div className="panel mt-3 px-6 py-4 text-[14px] leading-[1.7] text-muted">
        <span className="text-primary">Example:</span> {plain(EXAMPLE_VOLUME_USD)} traded on CHAT
        pays {plain(exampleFee)}.{" "}
        <span className="num text-primary">{plain(exampleFee * CASHBACK_SPLIT.holders)}</span> goes
        to CHAT holders and{" "}
        <span className="num text-primary">{plain(exampleFee * CASHBACK_SPLIT.creator)}</span> to
        CHAT&apos;s creator. Holders of other tokens get nothing from it.
      </div>

      {/* You */}
      <div className="card mt-10 p-7 sm:p-8">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="title text-primary">Your rewards</h2>
          {nextRun && (
            <span className="text-[13px] text-muted">
              Next payout {untilText(nextRun)} · {nextRun.toLocaleString()}
            </span>
          )}
        </div>

        {!wallet ? (
          <div className="mt-4 flex flex-wrap items-center gap-5">
            <p className="text-[14px] text-muted">
              Connect to see what you get as a holder and as a creator.
            </p>
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
                sub="Estimated, from today so far"
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
                  <li key={l.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3.5">
                    <span className="min-w-[72px] text-[15px] text-primary">{l.token}</span>
                    <span className="pill pill-quiet text-[11px]">{l.role}</span>
                    <span className="text-[13px] text-muted">
                      {l.ticker ? `paid in ${l.ticker}x` : "no pair yet, kept until one is picked"}
                    </span>
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

            {data.paid.length > 0 && (
              <Fold title={`Payouts to you (${data.paid.length})`}>
                <SimpleTable
                  head={["When", "Token", "Stock", "As", "Value", "Transaction"]}
                  rows={data.paid.map((p) => [
                    new Date(p.at).toLocaleDateString(),
                    shortAddr(p.mint, 4),
                    p.ticker,
                    p.role,
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
              </Fold>
            )}
          </>
        )}
      </div>

      {/* Every token */}
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
              p.symbol ?? shortAddr(p.mint, 4),
              p.ticker ? `${p.ticker}x` : "no pair yet",
              usd(p.holdersWaitingUsd),
              usd(p.holdersPaidUsd),
            ])}
          />
        )}
      </div>

      {/* The details, for whoever wants to check */}
      <div className="card mt-4 p-7 sm:p-8">
        <h2 className="title text-primary">Details</h2>

        <Fold title="Where the fees come from">
          <ul className="space-y-3 text-[14px] leading-[1.7] text-muted">
            <li>
              <span className="text-primary">Swaps on Coorwa:</span> {feePct}% of the COOK side,
              shown in the swap panel before you sign. Trading the same pool elsewhere pays Coorwa
              nothing, and earns its holders nothing either.
            </li>
            <li>
              <span className="text-primary">Launchpad buys:</span> MomoSwap pays Coorwa a share of
              its own 1% curve fee. It costs the trader nothing extra.
            </li>
            <li>
              <span className="text-primary">Setting a pair:</span> a creator of a token from
              outside Coorwa pays {plain(PAIR_LISTING_USD)} once. All of it goes to that
              token&apos;s holders.
            </li>
          </ul>
        </Fold>

        <Fold title="Rules">
          <ul className="list-disc space-y-2 pl-5 text-[14px] leading-[1.7] text-muted">
            <li>
              Anyone holding at least {plain(HOLDER_MIN_USD)} counts, wherever they bought. Pools,
              programs and Coorwa&apos;s own wallets never do.
            </li>
            <li>
              Balances are sampled at random moments through the day, so buying just before the
              payout does not help. Holding all day does.
            </li>
            <li>
              A creator is paid from fees only, and is not counted as a holder of their own token.
            </li>
            <li>
              Amounts under {plain(PAYOUT_MIN_USD)} in one stock carry over to the next day. Network
              and bridge costs come out of the payout and are shown below.
            </li>
          </ul>
        </Fold>

        <Fold title={`Payout runs${data?.runs?.length ? ` (${data.runs.length})` : ""}`}>
          <p className="text-[13px] leading-relaxed text-muted">
            Fees wait in the operator wallet{" "}
            {data?.operator && (
              <a
                href={cookieAccountUrl(data.operator)}
                target="_blank"
                rel="noreferrer"
                className="num underline underline-offset-4"
              >
                {shortAddr(data.operator, 5)}
              </a>
            )}{" "}
            until the daily run bridges them to Solana, buys each stock on Jupiter and sends it out.
          </p>
          {!data?.runs?.length ? (
            <p className="mt-3 text-[14px] text-muted">No runs yet.</p>
          ) : (
            <SimpleTable
              head={["Run", "State", "Paid", "Wallets", "Costs"]}
              rows={data.runs.map((r) => [
                r.bridgeSignature ? (
                  <a
                    key={r.id}
                    href={cookieTxUrl(r.bridgeSignature)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-[color:var(--divider-strong)] underline-offset-4"
                  >
                    {new Date(r.asOf).toLocaleDateString()}
                  </a>
                ) : (
                  new Date(r.asOf).toLocaleDateString()
                ),
                <span key={`s${r.id}`} title={r.note ?? undefined}>
                  {r.status}
                </span>,
                usd(r.totalUsd),
                String(r.wallets),
                r.costsUsd == null ? "-" : usd(r.costsUsd),
              ])}
            />
          )}
        </Fold>
      </div>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="glass-pane rounded-[var(--radius-float)] p-6">
      <div className="num grid h-8 w-8 place-items-center rounded-full text-[14px] text-primary [background:var(--well-fill)] [box-shadow:var(--well-edge)]">
        {n}
      </div>
      <div className="mt-4 text-[16px] text-primary">{title}</div>
      <p className="mt-1.5 text-[14px] leading-[1.65] text-muted">{body}</p>
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

/** A section closed by default, so the page leads with the numbers rather than the fine print. */
function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group mt-5 border-t border-hair pt-5">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[15px] text-primary">
        {title}
        <span className="text-muted transition-transform group-open:rotate-45" aria-hidden>
          +
        </span>
      </summary>
      <div className="mt-4">{children}</div>
    </details>
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

function pct(share: number): string {
  return `${Number((share * 100).toFixed(1))}%`;
}

/** "in 5 h", "in 40 min", or "any moment now" once it is due. */
function untilText(at: Date): string {
  const min = Math.round((at.getTime() - Date.now()) / 60_000);
  if (min <= 0) return "any moment now";
  if (min < 60) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

/** A round figure in the copy: $5, $1, $0.625. `usd` would print $5.00 and $0.6250. */
function plain(n: number): string {
  return `$${Number(n.toFixed(3))}`;
}
