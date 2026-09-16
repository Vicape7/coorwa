"use client";

import useSWR from "swr";
import { usd, amount } from "@/lib/format";
import {
  COOKIE_RPC_URL,
  COOKIESCAN_API,
  COOKIEBOX_AGG_API,
  CANDYSHOP_API,
  MOMOSWAP_API,
  SOLANA_RPC_URL,
  PROGRAM_IDS,
  BRIDGE,
  COOKIE_DOMAIN,
  SOLANA_DOMAIN,
} from "@/lib/config";

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

/**
 * What Coorwa depends on and whether it is up.
 *
 * Worth a page of its own: Coorwa is a thin, honest layer over other people's infrastructure, so
 * when something is wrong it is usually one of these, and naming them is more useful than a
 * generic error.
 */
export function StatusView() {
  const { data } = useSWR<ChainStatus>("/api/chain", fetcher, { refreshInterval: 5_000 });

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Status</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          What Coorwa runs on.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Coorwa holds nothing and operates nothing. Every number in the app comes from one of the
          services below, and every transaction is built by one of these programs and signed by your
          wallet.
        </p>
      </div>

      <div className="card mt-10 p-5 sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="title text-primary">Cookie Chain</h2>
          <span className="pill pill-quiet ml-auto">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                data?.healthy ? "live-dot bg-[var(--color-up)]" : "bg-[var(--color-down)]"
              }`}
            />
            {data ? (data.healthy ? "Healthy" : "Unreachable") : "Checking"}
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          <Figure label="Slot" value={data ? data.slot.toLocaleString("en-US") : null} />
          <Figure label="Block height" value={data ? data.blockHeight.toLocaleString("en-US") : null} />
          <Figure
            label="Epoch"
            value={
              data
                ? `${data.epoch}${data.epochProgress != null ? ` · ${Math.round(data.epochProgress * 100)}%` : ""}`
                : null
            }
          />
          <Figure label="Transactions" value={data ? amount(data.transactionCount, 0) : null} />
          <Figure label="Validator" value={data?.version ? `solana-core ${data.version}` : null} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card p-5 sm:p-8">
          <h2 className="title text-primary">Services</h2>
          <p className="mt-1.5 text-[13px] text-muted">
            Read paths and transaction builders Coorwa calls.
          </p>
          <dl className="mt-5 divide-y divide-[color:var(--divider)]">
            <Row label="RPC" value={COOKIE_RPC_URL} note="Chain reads, simulation, sending" />
            <Row label="Cookiescan" value={COOKIESCAN_API} note="Token registry and markets feed" />
            <Row label="Cookiebox" value={COOKIEBOX_AGG_API} note="Swap router (primary)" />
            <Row label="Candy Shop" value={CANDYSHOP_API} note="Swap router and trade history" />
            <Row label="MomoSwap" value={MOMOSWAP_API} note="Bonding-curve launchpad" />
            <Row label="Solana RPC" value={SOLANA_RPC_URL} note="The RWA side of a cross-chain route" />
          </dl>
        </div>

        <div className="card p-5 sm:p-8">
          <h2 className="title text-primary">Programs</h2>
          <p className="mt-1.5 text-[13px] text-muted">
            On-chain code Coorwa builds instructions against.
          </p>
          <dl className="mt-5 divide-y divide-[color:var(--divider)]">
            <Row label="Cookiebox DAMM v2" value={PROGRAM_IDS.cookieboxDamm} note="LP positions" />
            <Row label="Cookiebox CLMM" value={PROGRAM_IDS.cookieboxClmm} note="Routed liquidity" />
            <Row label="CookieSwap BAMM" value={PROGRAM_IDS.cookieswapBamm} note="Routed liquidity" />
            <Row label="MomoSwap" value={PROGRAM_IDS.momoswapLaunchpad} note="Launchpad curve" />
            <Row
              label="Warp (Cookie)"
              value={BRIDGE.cookie.warpProgramId}
              note={`Hyperlane domain ${COOKIE_DOMAIN}`}
            />
            <Row
              label="Warp (Solana)"
              value={BRIDGE.solana.warpProgramId}
              note={`Hyperlane domain ${SOLANA_DOMAIN}`}
            />
          </dl>
        </div>
      </div>

      <div className="card mt-4 p-5 sm:p-8">
        <h2 className="title text-primary">Cross-chain capacity</h2>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-muted">
          A cross-chain settle ends by swapping bridged COOK into an xStock on Solana, so the depth
          of COOK there is the real ceiling on trade size - not anything in Coorwa. It is shown here
          rather than discovered as slippage.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-3">
          <Figure
            label="COOK depth on Solana"
            value={data ? usd(data.bridge.cookLiquidityOnSolanaUsd) : null}
          />
          <Figure
            label="Holders on Solana"
            value={data?.bridge.cookHoldersOnSolana?.toLocaleString("en-US") ?? null}
          />
          <Figure label="COOK price" value={data ? usd(data.cookPriceUsd) : null} />
        </div>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="label text-[12px]">{label}</div>
      <div className="num mt-1.5 text-[17px] text-primary">
        {value ?? <span className="skeleton inline-block h-4 w-24 align-middle" />}
      </div>
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
      {/* On a phone the name takes its own line, so an address is not squeezed to three letters. */}
      <dt className="w-full text-[14px] text-primary sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="num min-w-0 flex-1 truncate text-[12px] text-muted">{value}</dd>
      <dd className="text-[12px] text-subtle">{note}</dd>
    </div>
  );
}
