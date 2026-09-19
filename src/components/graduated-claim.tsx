"use client";

/**
 * Claiming a token from the curve it graduated from.
 *
 * When a MomoSwap curve graduates, its liquidity moves to a pool on its own, but the tokens bought
 * on the curve do not: each buyer's shares wait on the programme until that buyer claims them. So
 * a pair page for a graduated token asks the connected wallet whether it still has some waiting,
 * and offers the claim right there. MomoSwap builds the transaction, Coorwa checks it against the
 * claim before the wallet signs, and nobody takes a fee.
 */
import { useCallback, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { cookieTxUrl } from "@/lib/config";
import { amount, shortAddr } from "@/lib/format";
import { decodeTx, signSendConfirm, explainError } from "@/lib/tx";
import { verifyLaunchpadBuild } from "@/lib/expectation";
import { Notice } from "./notice";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function GraduatedClaim({ mint, symbol }: { mint: string; symbol: string }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const { data, mutate } = useSWR<{ pool: string | null; tokens: number; claimable: boolean }>(
    wallet ? `/api/launchpad/graduated?mint=${mint}&wallet=${wallet}` : null,
    fetcher,
    { refreshInterval: 60_000 },
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<string | null>(null);

  const pool = data?.pool ?? null;

  const claim = useCallback(async () => {
    if (!publicKey || !signTransaction || !pool) return;
    setBusy(true);
    setError(null);
    try {
      const built = await fetch("/api/launchpad/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "claim-graduated-tokens",
          wallet: publicKey.toBase58(),
          pool,
        }),
      }).then((r) => r.json());
      if (built.error) throw new Error(built.hint ? `${built.error} - ${built.hint}` : built.error);

      await verifyLaunchpadBuild(built, {
        action: "claim-graduated-tokens",
        wallet: publicKey.toBase58(),
        pool,
        mint,
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
  }, [publicKey, signTransaction, connection, pool, mint, mutate]);

  if (!claimed && !data?.claimable) return null;

  return (
    <div className="card p-5">
      <div className="label">Claim tokens</div>
      {claimed ? (
        <div className="mt-3">
          <Notice tone="up">
            Claimed. Your {symbol} is in your wallet.{" "}
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
      ) : (
        <>
          <p className="mt-2.5 text-[13px] leading-[1.7] text-muted">
            {symbol} graduated from its launchpad curve. What you bought there waits on the curve
            until you claim it into your wallet.
          </p>
          <div className="mt-4 flex items-center justify-between gap-3">
            <div>
              <div className="label text-[11px]">Yours to claim</div>
              <div className="num text-[17px] text-primary">
                {amount(data?.tokens ?? 0)} {symbol}
              </div>
            </div>
            <button className="btn btn-primary shrink-0" disabled={busy} onClick={claim}>
              {busy ? "Confirm in your wallet" : "Claim tokens"}
            </button>
          </div>
        </>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="down">{error}</Notice>
        </div>
      )}
    </div>
  );
}
