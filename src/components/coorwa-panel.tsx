"use client";

/**
 * Buying and selling a token launched on Coorwa's curve, on the curve and then in its pool.
 *
 * Built in the page, like the launch it came from: the quote functions mirror the programs' own
 * arithmetic, so the number shown is the number the chain will compute, and the transaction is
 * assembled here rather than fetched from a server. Until the curve fills that means the curve;
 * once it has graduated, the pool the program opened and locked, traded directly on the pool
 * program with the same page and the same panel.
 *
 * Two things a trader should see before signing, and does. The token's tax is taken by the mint on
 * every transfer, so a buy delivers less than was sent and a sell arrives lighter than it left the
 * wallet; both are shown as their own line. And the fee is part of what a trade spends or returns
 * rather than something added to it: Coorwa's 1% on the curve, the pool's 1% after.
 */
import { useCallback, useMemo, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import useSWR from "swr";
import { COOK_DECIMALS, cookieTxUrl } from "@/lib/config";
import { amount, rawToUi, shortAddr, uiToRaw, usd } from "@/lib/format";
import { quoteBuy, quotePoolSwap, quoteSell } from "@/lib/launch-program";
import {
  curveFromSerialised,
  hasWrappedAccount,
  poolTradeInstructions,
  tradeInstructions,
} from "@/lib/launch-flow";
import { explainError, signSendConfirm } from "@/lib/tx";
import { Notice } from "./notice";
import type { CoorwaPair } from "@/lib/coorwa-pairs";

type Side = "buy" | "sell";

/** What a trade may lose to a price that moved between quoting and landing. */
const SLIPPAGE_BPS = 100n;

/** One quote, whichever venue priced it, in the terms the panel shows. */
interface Quote {
  /** What leaves the wallet, raw. */
  spent: bigint;
  /** What arrives in the wallet, raw, and the least the transaction may accept. */
  received: bigint;
  /** The tax the mint withholds, in raw base units. */
  tax: bigint;
  fee: { label: string; raw: bigint; decimals: number; symbol: string };
  graduates: boolean;
}

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
  const symbol = pair.base.symbol;
  const curve = useMemo(
    () => curveFromSerialised(pair.curve, pair.base.mint),
    [pair.curve, pair.base.mint],
  );
  const pool = pair.curve.state === "pooled" ? pair.pool : null;
  const tradable = pair.curve.state === "live" || pool != null;

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

  const quote = useMemo((): Quote | null => {
    if (raw <= 0n) return null;
    if (pool) {
      const q = quotePoolSwap(
        { liquidity: BigInt(pool.liquidity), sqrtPrice: BigInt(pool.sqrtPrice) },
        { amountIn: raw, inputIsBase: side === "sell", baseIsA: pool.baseIsA, taxBps: pair.curve.taxBps },
      );
      // The pool keeps its fee in its second token, which is COOK unless the pool lists it first.
      const feeInCook = pool.baseIsA;
      return {
        spent: raw,
        received: q.received,
        tax: side === "buy" ? q.out - q.received : q.amountIn - q.arrives,
        fee: {
          label: "Pool fee (1%)",
          raw: q.fee,
          decimals: feeInCook ? COOK_DECIMALS : decimals,
          symbol: feeInCook ? "COOK" : symbol,
        },
        graduates: false,
      };
    }
    const fee = { label: `Curve fee (${pair.curve.curveFeeBps / 100}%)`, decimals: COOK_DECIMALS, symbol: "COOK" };
    if (side === "buy") {
      const q = quoteBuy(curve, raw);
      // Checked against what the curve sends, which is what the program's slippage bound is on.
      return {
        spent: q.quoteTaken,
        received: q.baseReceived,
        tax: q.baseOut - q.baseReceived,
        fee: { ...fee, raw: q.fee },
        graduates: q.graduates,
      };
    }
    const q = quoteSell(curve, raw);
    return {
      spent: q.baseIn,
      received: q.quoteOut,
      tax: q.baseIn - q.baseReceived,
      fee: { ...fee, raw: q.fee },
      graduates: false,
    };
  }, [curve, pool, raw, side, pair.curve.taxBps, pair.curve.curveFeeBps, decimals, symbol]);

  const trade = useCallback(async () => {
    if (!publicKey || !signTransaction || raw <= 0n || !quote) return;
    setError(null);
    setFilled(null);
    setBusy(true);
    try {
      const closeWrapped = !(await hasWrappedAccount(connection, publicKey));
      const mint = new PublicKey(pair.base.mint);
      let instructions;
      if (pool) {
        instructions = poolTradeInstructions({
          trader: publicKey,
          mint,
          baseIsA: pool.baseIsA,
          side,
          amount: raw,
          // Bounded on what reaches the wallet, tax already off: the lowest figure the pool could
          // compare against, so the bound never refuses a trade that was quoted fairly.
          minOut: (quote.received * (10_000n - SLIPPAGE_BPS)) / 10_000n,
          closeWrapped,
        });
      } else {
        // The curve checks what it sends too: for a buy, the tokens before the tax.
        const sent = side === "buy" ? quote.received + quote.tax : quote.received;
        instructions = tradeInstructions({
          trader: publicKey,
          mint,
          side,
          amount: raw,
          minOut: (sent * (10_000n - SLIPPAGE_BPS)) / 10_000n,
          closeWrapped,
        });
      }
      const tx = new Transaction().add(...instructions);
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
  }, [publicKey, signTransaction, raw, quote, side, connection, pair.base.mint, pool, refreshBalance]);

  const cookSide = quote ? (side === "buy" ? quote.spent : quote.received) : 0n;

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
          <span>{side === "buy" ? "You pay (COOK)" : `You sell (${symbol})`}</span>
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
              side === "buy"
                ? `${amount(Number(quote.received) / 10 ** decimals, 2)} ${symbol}`
                : `${amount(Number(quote.received) / 10 ** COOK_DECIMALS, 4)} COOK`
            }
            strong
          />
          {quote.tax > 0n && (
            <Row
              label={`Token tax (${pair.curve.taxBps / 100}%)`}
              value={`${amount(Number(quote.tax) / 10 ** decimals, 2)} ${symbol} to holders`}
            />
          )}
          <Row
            label={quote.fee.label}
            value={`${amount(Number(quote.fee.raw) / 10 ** quote.fee.decimals, 4)} ${quote.fee.symbol}`}
          />
          {pair.cookPriceUsd != null && (
            <Row
              label="Value"
              value={usd((Number(cookSide) / 10 ** COOK_DECIMALS) * pair.cookPriceUsd)}
            />
          )}
          {quote.graduates && (
            <Row label="This buy graduates the curve" value="a pool opens and locks" strong />
          )}
        </dl>
      )}

      {!tradable && (
        <Notice tone="note">
          This curve has filled. Its pool is being opened and locked, and trading continues there
          within minutes.
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
            disabled={busy || raw <= 0n || !tradable}
            onClick={trade}
          >
            {busy ? "Working" : side === "buy" ? "Buy" : "Sell"}
          </button>
        )}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-subtle">
        {pool
          ? `This trades in the token's own pool, which Coorwa's program opened and locked for good. The pool's 1% is the only fee: most of it goes to the locked position, ${pair.curve.creatorLpShareBps / 100}% of that to the creator and the rest to Coorwa. The token's tax goes to its holders.`
          : "Coorwa's terminal fee does not apply to a token on its own curve, so the curve fee above is all you pay it. The token's tax goes to its holders, never to Coorwa."}
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
