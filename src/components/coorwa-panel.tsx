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
import {
  COOK_DECIMALS,
  COOK_LOGO,
  TRADE_SLIPPAGE_BPS,
  TRADE_SLIPPAGE_CHOICES,
  cookieTxUrl,
} from "@/lib/config";
import { amount, rawToUi, shortAddr, uiToRaw, usd } from "@/lib/format";
import { quoteBuy, quotePoolSwap, quoteSell } from "@/lib/launch-program";
import {
  cookHoldings,
  curveFromSerialised,
  poolTradeInstructions,
  spendableCook,
  tradeInstructions,
} from "@/lib/launch-flow";
import { explainError, signSendConfirm } from "@/lib/tx";
import { Notice } from "./notice";
import { TokenPill } from "./token-mark";
import type { CoorwaPair } from "@/lib/coorwa-pairs";

type Side = "buy" | "sell";

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

export function CoorwaPanel({ pair, header }: { pair: CoorwaPair; header?: React.ReactNode }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [side, setSide] = useState<Side>("buy");
  const [input, setInput] = useState("");
  /** What a trade may lose to a price that moved between quoting and landing. */
  const [slippageBps, setSlippageBps] = useState(TRADE_SLIPPAGE_BPS);
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

  /** What this wallet can pay with, plain and wrapped COOK together, for the buy side. */
  const { data: holdings, mutate: refreshHoldings } = useSWR(
    publicKey ? ["cook-holdings", publicKey.toBase58()] : null,
    () => cookHoldings(connection, publicKey!),
    { refreshInterval: 20_000 },
  );
  const spendable = holdings ? spendableCook(holdings) : undefined;

  const raw =Number(input) > 0 ? BigInt(uiToRaw(Number(input), side === "buy" ? COOK_DECIMALS : decimals)) : 0n;

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
      // Read fresh rather than from the panel's copy: this decides what gets wrapped and closed.
      const keep = 10_000n - BigInt(slippageBps);
      const held = await cookHoldings(connection, publicKey);
      const closeWrapped = held.wrapped === null;
      const wrappedHeld = held.wrapped ?? 0n;
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
          minOut: (quote.received * keep) / 10_000n,
          closeWrapped,
          wrappedHeld,
        });
      } else {
        // The curve checks what it sends too: for a buy, the tokens before the tax.
        const sent = side === "buy" ? quote.received + quote.tax : quote.received;
        instructions = tradeInstructions({
          trader: publicKey,
          mint,
          side,
          // A buy near the threshold takes less than was typed; offering only that much keeps the
          // rest out of the wrapped account, where it would stay when the account is not closed.
          amount: side === "buy" ? quote.spent : raw,
          minOut: (sent * keep) / 10_000n,
          closeWrapped,
          wrappedHeld,
        });
      }
      const tx = new Transaction().add(...instructions);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      const sent = await signSendConfirm(connection, tx, signTransaction);
      setFilled({ signature: sent.signature, side });
      setInput("");
      void refreshBalance();
      void refreshHoldings();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [
    publicKey,
    signTransaction,
    raw,
    quote,
    side,
    slippageBps,
    connection,
    pair.base.mint,
    pool,
    refreshBalance,
    refreshHoldings,
  ]);

  // Refused here rather than by the chain, whose answer is a failed transfer in the logs.
  const short =
    quote != null &&
    (side === "buy"
      ? spendable !== undefined && quote.spent > spendable
      : balance !== undefined && quote.spent > balance);

  /** The Max figure for the side in play, in whole units, or null while it is still loading. */
  const max =
    side === "buy"
      ? spendable !== undefined
        ? { raw: spendable, decimals: COOK_DECIMALS, digits: 4 }
        : null
      : balance !== undefined
        ? { raw: balance, decimals, digits: 2 }
        : null;

  const switchSide = (next: Side) => {
    // The typed number is COOK on one side and the token on the other, so it cannot carry over.
    setSide(next);
    setInput("");
  };
  const inSymbol = side === "buy" ? "COOK" : symbol;
  const outSymbol = side === "buy" ? symbol : "COOK";
  const cookUsd = (units: bigint) =>
    pair.cookPriceUsd != null ? usd((Number(units) / 10 ** COOK_DECIMALS) * pair.cookPriceUsd) : null;
  const payUsd = side === "buy" ? cookUsd(raw) : null;
  const getUsd = quote && side === "sell" ? cookUsd(quote.received) : null;

  return (
    <div className="card p-4 sm:p-5">
      {header && <div className="mb-4">{header}</div>}

      <div className="segmented w-full">
        <button onClick={() => switchSide("buy")} data-active={side === "buy"} className="flex-1">
          Buy
        </button>
        <button onClick={() => switchSide("sell")} data-active={side === "sell"} className="flex-1">
          Sell
        </button>
      </div>

      <label className="panel-raised mt-4 block p-4">
        <span className="label flex items-baseline justify-between text-[12px]">
          <span>{side === "buy" ? "You pay" : "You sell"}</span>
          {max && (
            <span className="num text-subtle">
              {amount(rawToUi(max.raw.toString(), max.decimals), max.digits)} {inSymbol}
            </span>
          )}
        </span>
        <span className="mt-2 flex items-center gap-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0"
            className="num w-full min-w-0 bg-transparent text-[30px] leading-none text-primary outline-none placeholder:text-[color:var(--text-subtle)]"
          />
          <TokenPill logo={side === "buy" ? COOK_LOGO : pair.base.logo} symbol={inSymbol} />
        </span>
        <span className="num mt-2 block text-[12px] text-subtle">{payUsd ?? " "}</span>
      </label>

      {/* Turns the trade round: what was paid is now received. */}
      <div className="relative z-10 -my-2.5 flex justify-center">
        <button
          type="button"
          onClick={() => switchSide(side === "buy" ? "sell" : "buy")}
          aria-label="Switch between buying and selling"
          className="nav-round h-9 w-9 text-muted"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
            <path
              d="M5 2.5v11M5 13.5 2.5 11M5 13.5 7.5 11M11 13.5v-11M11 2.5 8.5 5M11 2.5 13.5 5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="panel-raised p-4">
        <div className="label text-[12px]">You receive</div>
        <div className="mt-2 flex items-center gap-3">
          <div className="num w-full min-w-0 truncate text-[30px] leading-none text-primary">
            {quote ? (
              side === "buy" ? (
                amount(Number(quote.received) / 10 ** decimals, 2)
              ) : (
                amount(Number(quote.received) / 10 ** COOK_DECIMALS, 4)
              )
            ) : (
              <span className="text-subtle">0</span>
            )}
          </div>
          <TokenPill logo={side === "buy" ? pair.base.logo : COOK_LOGO} symbol={outSymbol} />
        </div>
        <div className="num mt-2 text-[12px] text-subtle">{getUsd ?? " "}</div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {[25, 50, 75, 100].map((p) => (
          <button
            key={p}
            type="button"
            disabled={!max || max.raw <= 0n}
            onClick={() => {
              if (!max) return;
              // At 100% the raw figure is used whole, so a rounded share cannot leave dust behind.
              const part = p === 100 ? max.raw : (max.raw * BigInt(p)) / 100n;
              setInput(String(rawToUi(part.toString(), max.decimals)));
            }}
            className="btn btn-quiet btn-sm num px-0 disabled:opacity-40"
          >
            {p}%
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <span className="label">Slippage</span>
        <div className="segmented ml-auto">
          {TRADE_SLIPPAGE_CHOICES.map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippageBps(bps)}
              data-active={slippageBps === bps}
              className="num"
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-[13px] empty:hidden">
        {quote && quote.tax > 0n && (
          <Row
            label={`Token tax (${pair.curve.taxBps / 100}%)`}
            value={`${amount(Number(quote.tax) / 10 ** decimals, 2)} ${symbol} to holders`}
          />
        )}
        {quote && (
          <Row
            label={quote.fee.label}
            value={`${amount(Number(quote.fee.raw) / 10 ** quote.fee.decimals, 4)} ${quote.fee.symbol}`}
          />
        )}
        {quote?.graduates && (
          <Row label="This buy graduates the curve" value="a pool opens and locks" strong />
        )}
      </dl>

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
          <button className="btn btn-primary w-full py-4 text-[16px]" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary w-full py-4 text-[16px]"
            disabled={busy || raw <= 0n || !tradable || short}
            onClick={trade}
          >
            {busy
              ? "Working"
              : short
                ? `Not enough ${side === "buy" ? "COOK" : symbol}`
                : side === "buy"
                  ? "Buy"
                  : "Sell"}
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
