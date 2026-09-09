"use client";

/**
 * On-chain swap against real Cookie Chain liquidity.
 *
 * Corwa quotes both aggregators and takes the better fill. The transaction is built upstream,
 * signed by the user's own wallet, simulated, then sent from their browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { COOK_MINT, COOK_DECIMALS, cookieTxUrl, DEFAULT_SLIPPAGE_BPS } from "@/lib/config";
import { rawToUi, uiToRaw, amount, pct, shortAddr } from "@/lib/format";
import { decodeTx, signSendConfirm, explainError } from "@/lib/tx";
import { Notice } from "./notice";
import type { SwapRoute } from "@/lib/swap";
import type { CorwaPair } from "@/lib/pairs";

type Side = "buy" | "sell";

const SLIPPAGE_CHOICES = [50, 100, 500, 1000];

export function SwapPanel({ pair }: { pair: CorwaPair }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [side, setSide] = useState<Side>("buy");
  const [input, setInput] = useState("");
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  /**
   * The quote and the request it answers, stored together - so "still quoting" is a comparison
   * against what is being asked for now rather than a flag written from inside the effect.
   */
  const [quoted, setQuoted] = useState<{
    key: string;
    quote: { best: SwapRoute; all: SwapRoute[] } | null;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ signature: string; confirmed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ cook: number; base: number | null }>({
    cook: 0,
    base: null,
  });

  const inMint = side === "buy" ? COOK_MINT : pair.base.mint;
  const outMint = side === "buy" ? pair.base.mint : COOK_MINT;
  const inDecimals = side === "buy" ? COOK_DECIMALS : pair.base.decimals;
  const outDecimals = side === "buy" ? pair.base.decimals : COOK_DECIMALS;
  const inSymbol = side === "buy" ? "COOK" : pair.base.symbol;
  const outSymbol = side === "buy" ? pair.base.symbol : "COOK";

  // Derived, not reset in an effect: with no wallet there is simply nothing to show.
  const shownBalances = publicKey ? balances : { cook: 0, base: null };
  const inBalance = side === "buy" ? shownBalances.cook : shownBalances.base;

  const amountNum = Number(input);
  const validAmount = Number.isFinite(amountNum) && amountNum > 0;

  useEffect(() => {
    if (!publicKey) return;
    let alive = true;
    const read = async () => {
      try {
        const [lamports, tokenAccounts] = await Promise.all([
          connection.getBalance(publicKey),
          connection.getParsedTokenAccountsByOwner(publicKey, {
            mint: new PublicKey(pair.base.mint),
          }),
        ]);
        if (!alive) return;
        const base = tokenAccounts.value.reduce(
          (sum, a) => sum + (a.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0),
          0,
        );
        setBalances({ cook: lamports / 10 ** COOK_DECIMALS, base });
      } catch {
        if (alive) setBalances((b) => ({ ...b, base: null }));
      }
    };
    read();
    const id = setInterval(read, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [publicKey, connection, pair.base.mint]);

  const quoteKey = validAmount ? `${inMint}|${outMint}|${amountNum}|${slippageBps}` : null;

  const seq = useRef(0);
  useEffect(() => {
    if (!validAmount || !quoteKey) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          inputMint: inMint,
          outputMint: outMint,
          amount: uiToRaw(amountNum, inDecimals),
          slippageBps: String(slippageBps),
        });
        if (publicKey) params.set("owner", publicKey.toBase58());
        const res = await fetch(`/api/quote?${params}`);
        const json = await res.json();
        if (seq.current !== mine) return;
        setQuoted(
          json.error
            ? {
                key: quoteKey,
                quote: null,
                error: json.hint ? `${json.error} - ${json.hint}` : json.error,
              }
            : { key: quoteKey, quote: json, error: null },
        );
      } catch (e) {
        if (seq.current === mine) {
          setQuoted({
            key: quoteKey,
            quote: null,
            error: e instanceof Error ? e.message : "quote failed",
          });
        }
      }
    }, 350);
    return () => clearTimeout(t);
  }, [amountNum, validAmount, quoteKey, inMint, outMint, inDecimals, slippageBps, publicKey]);

  const currentQuote = quoteKey && quoted?.key === quoteKey ? quoted : null;
  const activeQuote = currentQuote?.quote ?? null;
  const activeQuoteError = currentQuote?.error ?? null;
  const quoting = quoteKey !== null && currentQuote === null;

  const outAmount = activeQuote ? rawToUi(activeQuote.best.outAmount, outDecimals) : null;
  const minOut = activeQuote ? rawToUi(activeQuote.best.minOutAmount, outDecimals) : null;

  /**
   * What you end up holding, expressed in shares of the pair's RWA - the whole point of Corwa.
   *
   * COOK's own USD price is not passed into this component, but it is recoverable from the pair:
   * the base token's price is published both in USD and in COOK, and their ratio is COOK in USD.
   */
  const shares = useMemo(() => {
    if (outAmount == null || !(pair.quote.priceUsd > 0)) return null;
    let outUsd: number;
    if (side === "buy") {
      outUsd = outAmount * pair.base.priceUsd;
    } else {
      const cookUsd = pair.base.priceCook ? pair.base.priceUsd / pair.base.priceCook : null;
      if (cookUsd == null) return null;
      outUsd = outAmount * cookUsd;
    }
    return outUsd / pair.quote.priceUsd;
  }, [outAmount, side, pair]);

  const execute = useCallback(async () => {
    if (!publicKey || !signTransaction || !activeQuote) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/swap/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          aggregator: activeQuote.best.aggregator,
          owner: publicKey.toBase58(),
          inputMint: inMint,
          outputMint: outMint,
          amount: uiToRaw(amountNum, inDecimals),
          slippageBps,
          raw: activeQuote.best.aggregator === "candyshop" ? activeQuote.best.raw : undefined,
        }),
      });
      const built = await res.json();
      if (built.error) throw new Error(built.hint ? `${built.error} - ${built.hint}` : built.error);

      const tx = decodeTx(built.transactionBase64);
      const sent = await signSendConfirm(connection, tx, signTransaction);
      setResult(sent);
      setInput("");
      setQuoted(null);

      // Report the fill for cashback accounting. The server re-checks the signature on-chain, so a
      // failure here costs nothing but the record - never the trade.
      const notional =
        side === "buy" ? amountNum * (pair.base.priceCook ? pair.base.priceUsd / pair.base.priceCook : 0) : amountNum * pair.base.priceUsd;
      fetch("/api/rewards/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signature: sent.signature,
          wallet: publicKey.toBase58(),
          source: "swap",
          mint: pair.base.mint,
          symbol: pair.base.symbol,
          side,
          valueUsd: Number.isFinite(notional) ? Math.max(0, notional) : 0,
          // Neither Cookie Chain router exposes a platform-fee or referral parameter today, so a
          // swap routed through Corwa earns Corwa nothing. Recording it at zero keeps the volume
          // visible without inventing a rebate that no fee is backing.
          feeUsd: 0,
          chain: "cookie",
        }),
      }).catch(() => {});
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [
    publicKey,
    signTransaction,
    activeQuote,
    inMint,
    outMint,
    amountNum,
    inDecimals,
    slippageBps,
    connection,
    side,
    pair,
  ]);

  const insufficient = inBalance != null && validAmount && amountNum > inBalance;

  return (
    <div className="card overflow-hidden">
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
                setQuoted(null);
                setResult(null);
                setError(null);
              }}
              style={active ? { color: tone, boxShadow: `inset 0 -2px 0 0 ${tone}` } : undefined}
              className={`py-3.5 text-[13px] transition-colors ${
                active ? "" : "text-muted hover:text-[color:var(--text-primary)]"
              }`}
            >
              {s === "buy" ? "Buy" : "Sell"} {pair.base.symbol}
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
                {amount(inBalance)} {inSymbol}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0"
              className="num w-full bg-transparent text-[26px] text-primary outline-none placeholder:text-[color:var(--text-subtle)]"
            />
            <span className="pill shrink-0 bg-surface text-primary">{inSymbol}</span>
          </div>
        </div>

        <div className="panel-raised p-4">
          <div className="label mb-2">You receive</div>
          <div className="flex items-center gap-3">
            <div className="num w-full truncate text-[26px] text-primary">
              {quoting && !outAmount ? (
                <span className="skeleton inline-block h-7 w-36 align-middle" />
              ) : outAmount != null ? (
                amount(outAmount)
              ) : (
                <span className="text-subtle">0</span>
              )}
            </div>
            <span className="pill shrink-0 bg-surface text-primary">{outSymbol}</span>
          </div>
          {shares != null && shares > 0 && (
            <div className="mt-2 text-[12px] text-muted">
              &asymp;{" "}
              <span className="num text-primary">
                {shares < 0.0001 ? shares.toExponential(3) : shares.toFixed(6)}
              </span>{" "}
              {pair.quote.ticker} shares
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="label">Slippage</span>
          <div className="segmented ml-auto">
            {SLIPPAGE_CHOICES.map((bps) => (
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

        {activeQuote && <RouteDetail quote={activeQuote} minOut={minOut} outSymbol={outSymbol} />}

        {activeQuoteError && <Notice tone="down">{activeQuoteError}</Notice>}

        {!publicKey ? (
          <button className="btn btn-primary w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary w-full"
            disabled={!activeQuote || busy || insufficient || quoting}
            onClick={execute}
          >
            {busy
              ? "Confirm in your wallet"
              : insufficient
                ? `Not enough ${inSymbol}`
                : side === "buy"
                  ? `Buy ${pair.base.symbol}`
                  : `Sell ${pair.base.symbol}`}
          </button>
        )}

        {error && <Notice tone="down">{error}</Notice>}

        {result && (
          <Notice tone="up">
            {result.confirmed ? "Filled." : "Sent, awaiting confirmation."}{" "}
            <a
              href={cookieTxUrl(result.signature)}
              target="_blank"
              rel="noreferrer"
              className="num underline underline-offset-4"
            >
              {shortAddr(result.signature, 6)}
            </a>
          </Notice>
        )}
      </div>
    </div>
  );
}

function RouteDetail({
  quote,
  minOut,
  outSymbol,
}: {
  quote: { best: SwapRoute; all: SwapRoute[] };
  minOut: number | null;
  outSymbol: string;
}) {
  const [open, setOpen] = useState(false);
  const best = quote.best;
  const other = quote.all.find((r) => r.aggregator !== best.aggregator);

  const edge =
    other && BigInt(other.outAmount) > 0n
      ? (Number(BigInt(best.outAmount) - BigInt(other.outAmount)) /
          Number(BigInt(other.outAmount))) *
        100
      : null;

  return (
    <div className="panel-raised overflow-hidden text-[12px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="pill bg-surface text-[11px] text-primary">{best.aggregator}</span>
        <span className="truncate text-muted">
          {best.segments.map((s) => s.venue).join(" + ") || "direct"}
        </span>
        <span className="ml-auto shrink-0 text-muted">
          {best.priceImpactPct != null ? `${best.priceImpactPct.toFixed(2)}%` : "—"}
        </span>
        <span className="shrink-0 text-subtle">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-hair px-3.5 py-3 text-muted">
          <Line label="Minimum received">
            <span className="num text-primary">
              {minOut != null ? `${amount(minOut)} ${outSymbol}` : "—"}
            </span>
          </Line>
          {best.feeBps != null && best.feeBps > 0 && (
            <Line label="Router fee">
              <span className="num text-primary">{(best.feeBps / 100).toFixed(2)}%</span>
            </Line>
          )}
          <Line label="Hops">
            <span className="num text-primary">
              {best.isMultiHop ? `${best.segments.length} (multi-hop)` : "1"}
              {best.isSplit ? " · split" : ""}
            </span>
          </Line>
          {other && edge != null && (
            <Line label={`vs ${other.aggregator}`}>
              <span
                className="num"
                style={{ color: edge >= 0 ? "var(--color-up)" : "var(--color-down)" }}
              >
                {pct(edge, 3)}
              </span>
            </Line>
          )}
          <p className="pt-1.5 text-[11px] leading-relaxed text-subtle">
            Both Cookie Chain routers were quoted; this is the better fill. The transaction is built
            upstream and signed in your wallet - Corwa never holds your funds.
          </p>
        </div>
      )}
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
