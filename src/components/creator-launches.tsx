"use client";

/**
 * What a creator gets back from their own curve.
 *
 * Two different things arrive here and they come from different places, which is why they are shown
 * as separate lines rather than one total. MomoSwap pays the creator 35% of its 1% trade fee, so
 * 0.35% of every trade on the curve, and it sits on the pool until claimed with the creator's own
 * key. Coorwa's cashback pays the creator a share of Coorwa's referral revenue instead, and that is
 * settled through the vault on the rewards page, not here.
 *
 * The list comes from the pool feed rather than from Coorwa's own records, so a token launched
 * before any of this existed still shows up and can still be claimed. Once the token has a pair, the
 * same fees can also be taken as that pair's stock on Solana.
 */
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { cookieTxUrl } from "@/lib/config";
import { amount, usd, shortAddr } from "@/lib/format";
import { decodeTx, signSendConfirm, explainError } from "@/lib/tx";
import { verifyLaunchpadBuild } from "@/lib/expectation";
import { Notice } from "./notice";
import { TokenMark } from "./token-mark";
import { CreatorPayout } from "./creator-payout";
import type { LaunchpadPool } from "@/lib/launchpad";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function CreatorLaunches({
  pools,
  cookPriceUsd,
}: {
  pools: LaunchpadPool[];
  cookPriceUsd: number | null;
}) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const mine = useMemo(
    () => (wallet ? pools.filter((p) => p.creator === wallet) : []),
    [pools, wallet],
  );

  if (!wallet || mine.length === 0) return null;

  return (
    <div className="card p-5 sm:p-7">
      <h2 className="title text-primary">Your launches</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        MomoSwap pays you 0.35% of every trade on your curve. It accrues on the pool and is claimed
        with your own key, so nobody can move it but you.
      </p>

      <ul className="mt-5 space-y-2.5">
        {mine.map((p) => (
          <LaunchRow
            key={p.pubkey}
            pool={p}
            ticker={p.ticker ?? null}
            cookPriceUsd={cookPriceUsd}
          />
        ))}
      </ul>
    </div>
  );
}

function LaunchRow({
  pool,
  ticker,
  cookPriceUsd,
}: {
  pool: LaunchpadPool;
  ticker: string | null;
  cookPriceUsd: number | null;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<string | null>(null);

  const { data, mutate } = useSWR<{ pendingCook: number; error?: string }>(
    `/api/launchpad/creator-fees?pool=${pool.pubkey}`,
    fetcher,
    { refreshInterval: 30_000 },
  );
  const pending = data?.pendingCook ?? 0;

  const claim = useCallback(async () => {
    if (!publicKey || !signTransaction) return;
    setBusy(true);
    setError(null);
    setClaimed(null);
    try {
      const built = await fetch("/api/launchpad/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "claim-creator-fees",
          wallet: publicKey.toBase58(),
          pool: pool.pubkey,
        }),
      }).then((r) => r.json());
      if (built.error) throw new Error(built.hint ? `${built.error} - ${built.hint}` : built.error);

      await verifyLaunchpadBuild(built, {
        action: "claim-creator-fees",
        wallet: publicKey.toBase58(),
        pool: pool.pubkey,
      });

      const sent = await signSendConfirm(
        connection,
        decodeTx(built.transactionBase64),
        signTransaction,
      );
      setClaimed(sent.signature);
      mutate();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [publicKey, signTransaction, connection, pool.pubkey, mutate]);

  return (
    <li className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <TokenMark logo={pool.logo ?? null} symbol={pool.symbol} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-primary">
            {pool.name} <span className="text-subtle">{pool.symbol}</span>
          </div>
          <div className="num mt-0.5 text-[12px] text-muted">
            {ticker ? (
              <>
                {pool.symbol}/{ticker}
              </>
            ) : (
              <Link href="/pools" className="underline underline-offset-4">
                no pair yet, choose one
              </Link>
            )}
            {" · "}
            {usd(Number(pool.paymentRaisedNet) / 1e9)} raised
          </div>
        </div>
        <span className="pill pill-quiet shrink-0">{pool.status}</span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div>
          <div className="label text-[11px]">Yours to claim</div>
          <div className="num text-[15px] text-primary">
            {amount(pending)} COOK
            {cookPriceUsd && pending > 0 ? (
              <span className="ml-1.5 text-[12px] text-muted">{usd(pending * cookPriceUsd)}</span>
            ) : null}
          </div>
        </div>
        <button
          className="btn btn-quiet shrink-0"
          disabled={busy || !(pending > 0) || !publicKey}
          onClick={claim}
        >
          {busy ? "Confirm in your wallet" : ticker ? "Claim as COOK" : "Claim"}
        </button>
      </div>

      {error && (
        <div className="mt-3">
          <Notice tone="down">{error}</Notice>
        </div>
      )}
      {ticker && (
        <CreatorPayout
          pool={pool.pubkey}
          pendingCook={pending}
          ticker={ticker}
          onSettled={() => void mutate()}
        />
      )}

      {claimed && (
        <div className="mt-3">
          <Notice tone="up">
            Claimed.{" "}
            <a
              href={cookieTxUrl(claimed)}
              target="_blank"
              rel="noreferrer"
              className="num underline underline-offset-4"
            >
              {shortAddr(claimed, 6)}
            </a>
          </Notice>
        </div>
      )}
    </li>
  );
}
