"use client";

/**
 * Buying and selling on a launchpad curve.
 *
 * A buy routed through here names Coorwa as MomoSwap's referrer, so MomoSwap pays its referral
 * share of the curve fee to the operator wallet instead of keeping it. The trader pays exactly the
 * same either way, and the share joins the token's holder and creator rewards.
 *
 * MomoSwap builds the transaction and the user's own wallet signs it. Coorwa quotes the curve
 * locally beforehand, because the launchpad has no quote endpoint - see `src/lib/curve.ts`.
 */
import { TokenMark } from "./token-mark";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { COOK_DECIMALS, CASHBACK_SPLIT, cookieTxUrl } from "@/lib/config";
import { quoteBuy, quoteSell, curvePrice } from "@/lib/curve";
import { rawToUi, uiToRaw, amount, usd, shortAddr, pct } from "@/lib/format";
import { decodeTx, signSendConfirm, explainError } from "@/lib/tx";
import { verifyLaunchpadBuild } from "@/lib/expectation";
import { Notice } from "./notice";
import type { LaunchpadPool } from "@/lib/launchpad";

type Side = "buy" | "sell";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

/** A fill that landed, plus what the ledger made of it. */
interface Filled {
  signature: string;
  confirmed: boolean;
  side: Side;
  /** The holders' share of the fee this fill earned, which joins the token's holder pool. */
  poolUsd: number | null;
}

export function CurvePanel({
  pool,
  decimals,
  cookPriceUsd,
  onClose,
}: {
  pool: LaunchpadPool;
  decimals: number;
  cookPriceUsd: number | null;
  onClose: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [side, setSide] = useState<Side>("buy");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState<Filled | null>(null);
  const [cookBalance, setCookBalance] = useState<number | null>(null);

  const wallet = publicKey?.toBase58() ?? null;

  const { data: position, mutate: refreshPosition } = useSWR<{
    shares: string;
    source: string;
  }>(wallet ? `/api/launchpad/position?pool=${pool.pubkey}&wallet=${wallet}` : null, fetcher, {
    refreshInterval: 30_000,
  });

  useEffect(() => {
    if (!publicKey) return;
    let alive = true;
    const read = () =>
      connection
        .getBalance(publicKey)
        .then((l) => alive && setCookBalance(l / 10 ** COOK_DECIMALS))
        .catch(() => {});
    read();
    const id = setInterval(read, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [publicKey, connection]);

  // Derived rather than cleared in the effect: with no wallet there is simply nothing to show.
  const shownCook = publicKey ? cookBalance : null;
  const heldShares = position?.shares ?? "0";
  const heldTokens = rawToUi(heldShares, decimals);

  const live = pool.status === "live";
  const amountNum = Number(input);
  const validAmount = Number.isFinite(amountNum) && amountNum > 0;

  const quote = useMemo(() => {
    if (!validAmount) return null;
    return side === "buy"
      ? quoteBuy(pool, BigInt(uiToRaw(amountNum, COOK_DECIMALS)))
      : quoteSell(pool, BigInt(uiToRaw(amountNum, decimals)));
  }, [side, amountNum, validAmount, pool, decimals]);

  /** Marginal price on the curve, converted out of raw units into COOK per whole token. */
  const priceCook = curvePrice(pool) * 10 ** (decimals - COOK_DECIMALS);

  const outAmount = quote ? rawToUi(quote.outRaw, side === "buy" ? decimals : COOK_DECIMALS) : null;
  const cookLeg = side === "buy" ? amountNum : (outAmount ?? 0);
  const legUsd = cookPriceUsd ? cookLeg * cookPriceUsd : null;

  /** The launchpad's own split, read off this pool rather than assumed from the global config. */
  const referralPct = (pool.tradeFeeBps / 10_000) * (pool.referralFeeBps / 10_000) * 100;
  const minBuyCook = rawToUi(pool.minBuy, COOK_DECIMALS);

  const inBalance = side === "buy" ? shownCook : wallet ? heldTokens : null;
  const insufficient = inBalance != null && validAmount && amountNum > inBalance;
  const belowMin = side === "buy" && validAmount && amountNum < minBuyCook;

  const execute = useCallback(async () => {
    if (!publicKey || !signTransaction || !validAmount) return;
    setBusy(true);
    setError(null);
    setFilled(null);

    try {
      const owner = publicKey.toBase58();
      const shares = uiToRaw(amountNum, decimals);
      const built = await fetch("/api/launchpad/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          side === "buy"
            ? { action: "buy", wallet: owner, pool: pool.pubkey, amount: amountNum }
            : { action: "sell", wallet: owner, pool: pool.pubkey, shares },
        ),
      }).then((r) => r.json());
      if (built.error) throw new Error(built.hint ? `${built.error} - ${built.hint}` : built.error);

      // MomoSwap built this, so check it is the trade asked for before the wallet is shown it. The
      // server converts the buy amount with the same `uiToRaw`, so the raw figures agree exactly.
      // Which referrer to name is the server's call; what is checked is that the transaction names
      // exactly that one and pays nobody else.
      await verifyLaunchpadBuild(
        built,
        side === "buy"
          ? {
              action: "buy",
              wallet: owner,
              pool: pool.pubkey,
              paymentRaw: uiToRaw(amountNum, COOK_DECIMALS),
              referrer: built.referrer ?? null,
            }
          : { action: "sell", wallet: owner, pool: pool.pubkey, sharesRaw: shares },
      );

      const sent = await signSendConfirm(
        connection,
        decodeTx(built.transactionBase64),
        signTransaction,
      );

      // Report the fill for rewards. The server re-reads the transaction on chain and works out
      // the fee itself - it does not take this side's word for the size of the trade or the fee it
      // earned - so a failure here costs the record, never the trade.
      let poolUsd: number | null = null;
      try {
        const recorded = await fetch("/api/rewards/record", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            signature: sent.signature,
            wallet: publicKey.toBase58(),
            source: "launchpad",
            mint: pool.tokenMint,
            // The curve the trade ran on. The server checks the launchpad agrees it holds this mint.
            pool: pool.pubkey,
            side,
          }),
        }).then((r) => r.json());
        if (typeof recorded?.feeUsd === "number") {
          poolUsd = recorded.feeUsd * CASHBACK_SPLIT.holders;
        }
      } catch {
        // The ledger can miss a row; the trade still happened.
      }

      setFilled({ ...sent, side, poolUsd });
      setInput("");
      refreshPosition();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [
    publicKey,
    signTransaction,
    validAmount,
    side,
    amountNum,
    decimals,
    pool,
    connection,
    refreshPosition,
  ]);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-hair px-5 py-4">
        <TokenMark logo={pool.logo ?? null} symbol={pool.symbol} size={40} />
        <div className="min-w-0">
          <div className="truncate text-[15px] text-primary">
            {pool.name} <span className="text-subtle">{pool.symbol}</span>
          </div>
          <div className="num mt-0.5 text-[12px] text-muted">
            {amount(priceCook, 9)} COOK
            {cookPriceUsd ? ` · ${usd(priceCook * cookPriceUsd)}` : ""} per token
          </div>
        </div>
        <button
          onClick={onClose}
          className="ml-auto shrink-0 text-[12px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-2 border-b border-hair">
        {(["buy", "sell"] as Side[]).map((s) => {
          const active = side === s;
          const tone = s === "buy" ? "var(--color-up)" : "var(--color-down)";
          return (
            <button
              key={s}
              onClick={() => {
                setSide(s);
                setInput("");
                setError(null);
                setFilled(null);
              }}
              style={active ? { color: tone, boxShadow: `inset 0 -2px 0 0 ${tone}` } : undefined}
              className={`py-3 text-[13px] transition-colors ${
                active ? "" : "text-muted hover:text-[color:var(--text-primary)]"
              }`}
            >
              {s === "buy" ? "Buy" : "Sell"} {pool.symbol}
            </button>
          );
        })}
      </div>

      <div className="space-y-3 p-4">
        <div className="panel-raised p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="label">You pay</span>
            {inBalance != null && (
              <button
                onClick={() =>
                  setInput(String(side === "buy" ? Math.max(0, inBalance - 0.01) : inBalance))
                }
                className="num text-[12px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
              >
                {amount(inBalance)} {side === "buy" ? "COOK" : pool.symbol}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0"
              className="num w-full bg-transparent text-[24px] text-primary outline-none placeholder:text-[color:var(--text-subtle)]"
            />
            <span className="pill shrink-0 bg-surface text-primary">
              {side === "buy" ? "COOK" : pool.symbol}
            </span>
          </div>
          {side === "sell" && heldTokens > 0 && (
            <div className="segmented mt-3">
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  onClick={() =>
                    // At 100% the raw figure is used whole, so a rounded share cannot strand dust.
                    setInput(p === 100 ? String(heldTokens) : String((heldTokens * p) / 100))
                  }
                  className="num flex-1"
                >
                  {p}%
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="panel-raised p-4">
          <div className="label mb-2">You receive, roughly</div>
          <div className="flex items-center gap-3">
            <div className="num w-full truncate text-[24px] text-primary">
              {outAmount != null ? amount(outAmount) : <span className="text-subtle">0</span>}
            </div>
            <span className="pill shrink-0 bg-surface text-primary">
              {side === "buy" ? pool.symbol : "COOK"}
            </span>
          </div>
          {legUsd != null && legUsd > 0 && (
            <div className="num mt-2 text-[12px] text-muted">{usd(legUsd)}</div>
          )}
        </div>

        {quote && (
          <div className="panel-raised space-y-1.5 px-3.5 py-3 text-[12px] text-muted">
            <Line label="Price impact">
              <span className="num text-primary">
                {/* Two decimals would print a real move on a deep curve as a flat +0.00%. */}
                {quote.impactPct !== 0 && Math.abs(quote.impactPct) < 0.01
                  ? "under 0.01%"
                  : pct(quote.impactPct, 2)}
              </span>
            </Line>
            <Line label="Launchpad fee">
              <span className="num text-primary">
                {amount(rawToUi(quote.feeRaw, COOK_DECIMALS))} COOK
              </span>
            </Line>
            {side === "buy" && (
              <p className="pt-1 text-[11px] leading-relaxed text-subtle">
                Coorwa is named referrer on this buy, which routes {referralPct.toFixed(2)}% of the
                trade to this token&apos;s holders and creator. MomoSwap pays that slice to whoever
                is named and keeps it when nobody is, so it costs you nothing.
              </p>
            )}
          </div>
        )}

        {!publicKey ? (
          <button className="btn btn-primary w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary w-full"
            disabled={!live || !quote || busy || insufficient || belowMin}
            onClick={execute}
          >
            {!live
              ? `This curve is ${pool.status}`
              : busy
                ? "Confirm in your wallet"
                : insufficient
                  ? `Not enough ${side === "buy" ? "COOK" : pool.symbol}`
                  : belowMin
                    ? `Minimum buy is ${amount(minBuyCook)} COOK`
                    : side === "buy"
                      ? `Buy ${pool.symbol}`
                      : `Sell ${pool.symbol}`}
          </button>
        )}

        {side === "sell" && wallet && heldTokens === 0 && (
          <Notice tone="note">Nothing to sell: this wallet holds no shares in this curve.</Notice>
        )}

        {error && <Notice tone="down">{error}</Notice>}

        {filled && (
          <Notice tone="up">
            {filled.confirmed ? "Filled." : "Sent, awaiting confirmation."}{" "}
            <a
              href={cookieTxUrl(filled.signature)}
              target="_blank"
              rel="noreferrer"
              className="num underline underline-offset-4"
            >
              {shortAddr(filled.signature, 6)}
            </a>
            {filled.poolUsd != null && filled.poolUsd > 0 && (
              <> Added {usd(filled.poolUsd)} to this token&apos;s holder rewards.</>
            )}
          </Notice>
        )}
      </div>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      {children}
    </div>
  );
}
