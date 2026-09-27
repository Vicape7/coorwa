"use client";

/**
 * The frame every pair page shares: a back pill, an About strip that says what the token pays and
 * carries its links, the trade card on the left with the token at its head, the chart on the right
 * with its figures above it, and the activity under both across the whole width.
 *
 * The chart column stretches to the trade card's height and never the other way round: the chart
 * only fills what the row already has, so nothing below it can be pushed out of the page.
 */
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { TokenMark } from "./token-mark";
import { CountUp, GraduationBar } from "./graduation";
import type { RewardPool } from "@/lib/rewards-ledger";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export interface AboutStat {
  label: string;
  value: string;
  /** A number the value is drawn from, when it should count up to each new figure instead of jumping. */
  count?: { to: number; format: (n: number) => string };
  /** 0 to 1, drawn as a thin bar under the value. */
  progress?: number;
}

export interface AboutLink {
  label: string;
  /** Opened in a new tab. */
  href?: string;
  /** Copied to the clipboard instead, for an address. */
  copy?: string;
  icon: "explorer" | "copy" | "pool" | "stock";
}

export function PairLayout({
  about,
  stats,
  links,
  panel,
  chart,
  activity,
}: {
  about: React.ReactNode;
  stats: AboutStat[];
  links: AboutLink[];
  /** The trade card, with the token at its head. */
  panel: React.ReactNode;
  chart: React.ReactNode;
  activity: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-6">
      <Link href="/terminal" className="btn btn-ghost btn-sm">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
          <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </Link>

      <section className="card mt-4 flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 lg:max-w-[560px]">
          <h2 className="text-[16px] font-medium text-primary">About</h2>
          <p className="mt-2 text-[13px] leading-[1.65] text-muted">{about}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 lg:justify-end">
          {stats.map((s) => (
            <div
              key={s.label}
              className={`${s.progress != null ? "min-w-[200px]" : "min-w-[112px]"} lg:text-right`}
            >
              <div className="text-[12px] text-subtle">{s.label}</div>
              <div className="num mt-0.5 text-[14px] text-primary">
                {s.count ? <CountUp value={s.count.to} format={s.count.format} /> : s.value}
              </div>
              {s.progress != null && <GraduationBar progress={s.progress} className="mt-2 [--grad-h:6px]" />}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {links.map((l) => (
              <AboutChip key={l.label} link={l} />
            ))}
          </div>
        </div>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">{panel}</div>
        <div className="flex min-w-0">{chart}</div>
      </div>

      <div className="mt-4">{activity}</div>
    </div>
  );
}

/** The token at the head of the trade card: its picture, its name, what it is priced in. */
export function PanelIdentity({
  logo,
  name,
  symbol,
  sub,
}: {
  logo: string | null;
  name: string;
  symbol: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <TokenMark logo={logo} symbol={symbol} size={48} />
      <div className="min-w-0">
        <h1 className="truncate text-[18px] font-medium leading-tight text-primary">{name}</h1>
        <div className="mt-0.5 truncate text-[12px] text-muted">
          {symbol}
          {sub && <span className="text-subtle"> · {sub}</span>}
        </div>
      </div>
    </div>
  );
}

function AboutChip({ link }: { link: AboutLink }) {
  const [copied, setCopied] = useState(false);
  const inner = (
    <>
      <ChipIcon icon={link.icon} />
      {copied ? "Copied" : link.label}
    </>
  );
  const className = "pill pill-quiet transition-colors hover:text-[color:var(--text-primary)]";
  if (link.copy) {
    const value = link.copy;
    return (
      <button
        type="button"
        className={className}
        title={value}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noreferrer" className={className}>
      {inner}
    </a>
  );
}

function ChipIcon({ icon }: { icon: AboutLink["icon"] }) {
  const paths: Record<AboutLink["icon"], string> = {
    explorer: "M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9M9.5 2H14v4.5M14 2 7.5 8.5",
    copy: "M5.5 5.5V3.5A1.5 1.5 0 0 1 7 2h5.5A1.5 1.5 0 0 1 14 3.5V9a1.5 1.5 0 0 1-1.5 1.5h-2M3.5 5.5H9A1.5 1.5 0 0 1 10.5 7v5.5A1.5 1.5 0 0 1 9 14H3.5A1.5 1.5 0 0 1 2 12.5V7a1.5 1.5 0 0 1 1.5-1.5Z",
    pool: "M8 2.5c2.5 3 4 5.2 4 7a4 4 0 0 1-8 0c0-1.8 1.5-4 4-7Z",
    stock: "M2 12.5 6 8.5l2.5 2.5L14 5.5M10.5 5.5H14V9",
  };
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden>
      <path d={paths[icon]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** What a token's holders have been paid and are owed, shared by the About strip and its tab. */
export function useRewardPool(mint: string) {
  const { data } = useSWR<{ configured: boolean; pool: RewardPool | null; nextRunAt: string | null }>(
    `/api/rewards/token?mint=${mint}`,
    fetcher,
    { refreshInterval: 60_000 },
  );
  return { pool: data?.pool ?? null, nextRunAt: data?.nextRunAt ?? null };
}

/**
 * The card under the chart: fills, rewards and facts behind one segmented switch.
 */
export function ActivityCard({
  fills,
  rewards,
  facts,
}: {
  fills: React.ReactNode;
  rewards: React.ReactNode;
  facts: React.ReactNode;
}) {
  const [tab, setTab] = useState<"fills" | "rewards" | "facts">("fills");
  return (
    <section className="card p-4 sm:p-5">
      <div className="segmented">
        <button onClick={() => setTab("fills")} data-active={tab === "fills"}>
          Recent fills
        </button>
        <button onClick={() => setTab("rewards")} data-active={tab === "rewards"}>
          Holder rewards
        </button>
        <button onClick={() => setTab("facts")} data-active={tab === "facts"}>
          Facts
        </button>
      </div>
      <div className="mt-4">{tab === "fills" ? fills : tab === "rewards" ? rewards : facts}</div>
    </section>
  );
}
