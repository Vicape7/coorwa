"use client";

import useSWR from "swr";
import { usd, amount } from "@/lib/format";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface ChainStatus {
  healthy: boolean;
  version: string | null;
  slot: number;
  blockHeight: number;
  epoch: number;
  epochProgress: number | null;
  transactionCount: number;
  cookPriceUsd: number | null;
  bridge: {
    cookLiquidityOnSolanaUsd: number | null;
    cookHoldersOnSolana: number | null;
  };
  error?: string;
}

export function LiveStats() {
  const { data } = useSWR<ChainStatus>("/api/chain", fetcher, { refreshInterval: 5_000 });

  const cells = [
    { label: "Slot", value: data ? data.slot.toLocaleString("en-US") : null },
    { label: "Epoch", value: data ? String(data.epoch) : null },
    { label: "Transactions", value: data ? amount(data.transactionCount, 0) : null },
    { label: "COOK", value: data ? usd(data.cookPriceUsd) : null },
    { label: "Bridge depth", value: data ? usd(data.bridge.cookLiquidityOnSolanaUsd) : null },
  ];

  return (
    <div className="card p-2">
      <div className="grid grid-cols-2 sm:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label} className="px-5 py-4">
            <div className="label text-[12px]">{c.label}</div>
            <div className="num mt-2 text-[19px] text-primary">
              {c.value ?? <span className="skeleton inline-block h-5 w-24 align-middle" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChainBadge() {
  const { data } = useSWR<ChainStatus>("/api/chain", fetcher, { refreshInterval: 10_000 });

  return (
    <span className="pill pill-quiet">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          data?.healthy
            ? "live-dot bg-[var(--color-up)]"
            : data
              ? "bg-[var(--color-down)]"
              : "bg-[color:var(--text-subtle)]"
        }`}
      />
      {data
        ? data.healthy
          ? `Live · slot ${data.slot.toLocaleString("en-US")}`
          : "Chain unreachable"
        : "Connecting"}
    </span>
  );
}
