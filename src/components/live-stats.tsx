"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { usd } from "@/lib/format";
import type { CashbackSummary } from "@/lib/cashback";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

/** "in 3h 12m", "Due now", or the cadence while nothing is waiting. */
function untilRun(at: string | null, now: number): string {
  if (!at) return "Every 24h";
  const left = new Date(at).getTime() - now;
  if (left <= 60_000) return "Due now";
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

export function LiveStats() {
  const { data } = useSWR<CashbackSummary>("/api/rewards", fetcher, {
    refreshInterval: 30_000,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const totals = data?.totals;
  const cells = [
    { label: "Paid out", value: totals ? usd(totals.paidUsd) : null },
    { label: "Waiting to be paid", value: totals ? usd(totals.waitingUsd) : null },
    { label: "Tokens paired", value: totals ? String(totals.tokensPaired) : null },
    { label: "Next payout", value: data && totals ? untilRun(data.nextRunAt, now) : null },
  ];

  return (
    // A pane rather than a card: this one sits directly on the hero's shader, where the denser
    // card film would read as the one opaque rectangle in an otherwise glass composition.
    <div className="glass-pane rounded-[var(--radius-float)] p-2">
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="px-3 py-4 sm:px-5">
            <div className="label text-[12px]">{c.label}</div>
            <div className="num mt-2 truncate text-[17px] text-primary sm:text-[19px]">
              {c.value ?? <span className="skeleton inline-block h-5 w-24 align-middle" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
