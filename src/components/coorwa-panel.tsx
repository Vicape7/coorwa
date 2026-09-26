"use client";

/**
 * Buying and selling on a Coorwa curve.
 *
 * Built in the page, like the launch it came from: the quote functions mirror the program's own
 * arithmetic, so the number shown is the number the chain will compute, and the transaction is
 * assembled here rather than fetched from a server.
 *
 * Two things a trader should see before signing, and does. The token's tax is taken by the mint on
 * every transfer, so a buy delivers less than the curve sends and a sell reaches the curve lighter
 * than it left the wallet; both are shown as their own line. And Coorwa's 1% is part of what a buy
 * spends rather than something added to it.
 */
import { useCallback, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import useSWR from "swr";
import { COOK_DECIMALS, cookieTxUrl } from "@/lib/config";
import { amount, rawToUi, shortAddr, uiToRaw, usd } from "@/lib/format";
import { quoteBuy, quoteSell } from "@/lib/launch-program";
import { curveFromSerialised, hasWrappedAccount, tradeInstructions } from "@/lib/launch-flow";
import { explainError, signSendConfirm } from "@/lib/tx";
import { Transaction } from "@solana/web3.js";
import { Notice } from "./notice";
import type { CoorwaPair } from "@/lib/coorwa-pairs";

type Side = "buy" | "sell";

/** What a trade may lose to a curve that moved between quoting and landing. */
const SLIPPAGE_BPS = 100n;

export function CoorwaPanel({ pair }: { pair: CoorwaPair }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [side, setSide] = useState<Side>("buy");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState<{ signature: string; side: Side } | null>(null);

  const decimals = pair.base.decimals;
  const curve = useMemo(
    () => curveFromSerialised(pair.curve, pair.base.mint),
    [pair.curve, pair.base.mint],
  );
  const live = pair.curve.state === "live";

  /** What this wallet holds of the token, for the sell side and its Max button. */
  const { data: balance, mutate: refreshBalance } = useSWR(
    publicKey ? ["coorwa-balance", pair.base.mint, publicKey.toBase58()] : null,
    async () => {
      const account = getAssociatedTokenAddressSync(
        new PublicKey(pair.base.mint),
        publicKey!,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const info = await connection.getTokenAccountBalance(account).catch(() => null);
      return info ? BigInt(info.value.amount) : 0n;
    },
    { refreshInterval: 20_000 },
  );

  const raw = Number(input) > 0 ? BigInt(uiToRaw(Number(input), side === "buy" ? COOK_DECIMALS : decimals)) : 0n;

  const quote = useMemo(() => {
    if (raw <= 0n) return null;
    return side === "buy" ? quoteBuy(curve, raw) : quoteSell(curve, raw);
  }, [curve, raw, side]);

  const trade = useCallback(async () => {
    if (!publicKey || !signTransaction || raw <= 0n || !quote) return;
    setError(null);
    setFilled(null);
    setBusy(true);
    try {
      const minOut =
        side === "buy"
          ? ((quote as ReturnType<typeof quoteBuy>).baseOut * (10_000n - SLIPPAGE_BPS)) / 10_000n
          : ((quote as ReturnType<typeof quoteSell>).quoteOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

      const tx = new Transaction().add(
        ...tradeInstructions({
          trader: publicKey,
          mint: new PublicKey(pair.base.mint),
          side,
          amount: raw,
          minOut,
          closeWrapped: !(await hasWrappedAccount(connection, publicKey)),
        }),
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      const sent = await signSendConfirm(connection, tx, signTransaction);
      setFilled({ signature: sent.signature, side });
      setInput("");
      void refreshBalance();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [publicKey, signTransaction, raw, quote, side, connection, pair.base.mint, refreshBalance]);

  const buy = side === "buy" ? (quote as ReturnType<typeof quoteBuy> | null) : null;
  const sell = side === "sell" ? (quote as ReturnType<typeof quoteSell> | null) : null;

  return (
    <div className="card p-5 sm:p-6">
      <div className="segmented w-full">
        <button onClick={() => setSide("buy")} data-active={side === "buy"} className="flex-1">
          Buy
        </button>
        <button onClick={() => setSide("sell")} data-active={side === "sell"} className="flex-1">
          Sell
        </button>
      </div>

      <label className="mt-4 block">
        <span className="label mb-1.5 flex items-baseline justify-between text-[12px]">
          <span>{side === "buy" ? "You pay (COOK)" : `You sell (${pair.base.symbol})`}</span>
          {side === "sell" && balance !== undefined && (
            <button
              className="text-[12px] text-muted underline underline-offset-4"
              onClick={() => setInput(String(rawToUi(balance.toString(), decimals)))}
            >
              Max {amount(rawToUi(balance.toString(), decimals), 2)}
            </button>
          )}
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          placeholder="0"
          className="field num w-full"
        />
      </label>

      {quote && (
        <dl className="mt-4 space-y-2 text-[13px]">
          <Row
            label="You receive"
            value={
              buy
                ? `${amount(Number(buy.baseReceived) / 10 ** decimals, 2)} ${pair.base.symbol}`
                : `${amount(Number(sell!.quoteOut) / 10 ** COOK_DECIMALS, 4)} COOK`
            }
            strong
          />
          {buy && buy.baseOut !== buy.baseReceived && (
            <Row
              label={`Token tax (${pair.curve.taxBps / 100}%)`}
              value={`${amount(Number(buy.baseOut - buy.baseReceived) / 10 ** decimals, 2)} ${pair.base.symbol} to holders`}
            />
          )}
          {sell && sell.baseIn !== sell.baseReceived && (
            <Row
              label={`Token tax (${pair.curve.taxBps / 100}%)`}
              value={`${amount(Number(sell.baseIn - sell.baseReceived) / 10 ** decimals, 2)} ${pair.base.symbol} to holders`}
            />
          )}
          <Row
            label={`Curve fee (${pair.curve.curveFeeBps / 100}%)`}
            value={`${amount(Number((buy ?? sell)!.fee) / 10 ** COOK_DECIMALS, 4)} COOK`}
          />
          {pair.cookPriceUsd != null && (
            <Row
              label="Value"
              value={usd(
                (Number(buy ? buy.quoteTaken : sell!.quoteOut) / 10 ** COOK_DECIMALS) *
                  pair.cookPriceUsd,
              )}
            />
          )}
          {buy?.graduates && (
            <Row label="This buy graduates the curve" value="a pool opens and locks" strong />
          )}
        </dl>
      )}

      {!live && (
        <Notice tone="note">
          This curve has finished. Its pool opens on Cookiebox and trading moves there.
        </Notice>
      )}
      {error && <Notice tone="down">{error}</Notice>}
      {filled && (
        <Notice tone="up">
          {filled.side === "buy" ? "Bought" : "Sold"}.{" "}
          <a
            href={cookieTxUrl(filled.signature)}
            target="_blank"
            rel="noreferrer"
            className="num underline underline-offset-4"
          >
            {shortAddr(filled.signature, 6)}
          </a>
        </Notice>
      )}

      <div className="mt-4">
        {!publicKey ? (
          <button className="btn btn-primary w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary w-full"
            disabled={busy || raw <= 0n || !live}
            onClick={trade}
          >
            {busy ? "Working" : side === "buy" ? "Buy" : "Sell"}
          </button>
        )}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-subtle">
        Coorwa&apos;s terminal fee does not apply to a token on its own curve, so the curve fee above
        is all you pay it. The token&apos;s tax goes to its holders, never to Coorwa.
      </p>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={`num ${strong ? "text-primary" : "text-muted"}`}>{value}</dd>
    </div>
  );
}
