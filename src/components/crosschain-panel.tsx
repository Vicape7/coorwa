"use client";

/**
 * Cross-chain settlement, both directions.
 *
 *   Buy   TOKEN on Cookie Chain  ->  a real xStock in the user's own Solana wallet
 *   Sell  that xStock            ->  back into TOKEN on Cookie Chain
 *
 * The return trip is what makes this a market rather than a quote. A pair you can only enter is a
 * price; a pair you can leave is a position. Coorwa still never wraps an xStock onto Cookie Chain -
 * those mints carry a permanent delegate, a pause authority and a live rebase multiplier, so a
 * wrapped representation could be seized, frozen or drift off its backing. Both directions route
 * through the user's own wallet on both chains instead.
 *
 * Each direction is three legs and three signatures, with an asynchronous relayer in the middle,
 * which is the whole reason this panel is built around a journey rather than a promise. Once the
 * bridge has dispatched, a failure on the last leg is not a failed trade - it is a half-finished
 * one, with the user's COOK sitting on the other chain. So the run is written to storage leg by
 * leg and can be picked up from the middle: see `lib/journey.ts` for the state and
 * `lib/crosschain-exec.ts` for the legs themselves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection } from "@solana/web3.js";
import { DEFAULT_SLIPPAGE_BPS, SOLANA_RPC_IS_PUBLIC, SOLANA_RPC_URL } from "@/lib/config";
import { RWA_DECIMALS } from "@/lib/rwa";
import { amount as fmtAmount, shortAddr, timeAgo, usd } from "@/lib/format";
import { sharesToRaw, type RwaHolding } from "@/lib/rwa-holding";
import {
  clearJourney,
  fundsLocation,
  hasTouchedChain,
  isResumable,
  loadJourney,
  newJourney,
  saveJourney,
  type Journey,
  type JourneyDirection,
} from "@/lib/journey";
import { runJourney } from "@/lib/crosschain-exec";
import { RouteSteps } from "./route-steps";
import { Notice } from "./notice";
import type { CoorwaPair } from "@/lib/pairs";
import type { RouteLeg } from "@/lib/crosschain";

/** Whatever the two planners return, reduced to the handful of things this panel draws. */
interface PlanView {
  legs: RouteLeg[];
  outAmount: number;
  outSymbol: string;
  /**
   * Null for the sell direction, where the value is the token's own live price and is worked out at
   * render time. Freezing it into the plan would leave a dollar figure that stops moving while the
   * price beside it keeps going.
   */
  outUsd: number | null;
  outWhere: string;
  totalPriceImpactPct: number;
  warnings: string[];
}

export function CrossChainPanel({ pair }: { pair: CoorwaPair }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  // The Solana leg needs its own connection: the wallet's provider points at Cookie Chain.
  const solanaConn = useMemo(() => new Connection(SOLANA_RPC_URL, "confirmed"), []);

  const [direction, setDirection] = useState<JourneyDirection>("buy");
  const [input, setInput] = useState("");
  /** Set by the Max button, cleared by any edit. It means "spend the account, not the number". */
  const [maxed, setMaxed] = useState(false);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [running, setRunning] = useState(false);

  const [holding, setHolding] = useState<RwaHolding | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  /** The ticker the two figures above belong to, so a size is never priced against a stale one. */
  const [rwaLoadedFor, setRwaLoadedFor] = useState<string | null>(null);

  const amountNum = Number(input);
  const valid = Number.isFinite(amountNum) && amountNum > 0;

  // Pulled out because SWR hands back a new `pair` object every 15 seconds. Depending on the object
  // would re-price the route on every refresh, for a request whose inputs have not changed.
  const { mint: baseMint, symbol: baseSymbol, decimals: baseDecimals } = pair.base;
  const ticker = pair.quote.ticker;

  // --- A route left over from a previous visit --------------------------------------------------

  /**
   * Restored during render rather than from an effect.
   *
   * The wallet address is not known on the first render, so this is the "adjust state when the
   * input changes" case: comparing the key React already has against the one being rendered now.
   * Doing it in an effect would paint the panel once without the stuck route and once with it.
   */
  const owner = publicKey?.toBase58() ?? null;
  const restoreKey = owner ? `${owner}|${pair.slug}` : null;
  const [restoredFor, setRestoredFor] = useState<string | null>(null);

  if (restoredFor !== restoreKey) {
    setRestoredFor(restoreKey);
    const stored = owner ? loadJourney(owner, pair.slug) : null;
    if (isResumable(stored)) {
      // A route stored as "running" was running in a tab that is now gone. Nothing is driving it,
      // so it is interrupted whatever the last write said.
      setJourney({ ...stored, status: "interrupted" });
      setDirection(stored.direction);
    } else {
      setJourney(null);
    }
  }

  // --- The Solana-side position, which the sell direction is priced from ------------------------

  /**
   * Read through Coorwa's own route, not straight from the browser.
   *
   * Solana's public RPC returns 403 to anything with a browser origin, and a failed multiplier read
   * falls back to 1 - which would size every sale wrong by exactly the rebase, quietly.
   */
  useEffect(() => {
    if (direction !== "sell") return;
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({ ticker });
        if (owner) params.set("owner", owner);
        const json = await fetch(`/api/rwa/holding?${params}`).then((r) => r.json());
        if (cancelled || json.error) return;
        setMultiplier(json.multiplier ?? 1);
        setHolding(json.holding ?? null);
      } catch {
        // Keep whatever is already known. A multiplier of 1 is the honest fallback, and the panel
        // is still usable - only Max needs the account itself.
      } finally {
        if (!cancelled) setRwaLoadedFor(ticker);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [direction, owner, ticker]);

  /**
   * Raw units for the sell leg.
   *
   * Max spends the token account verbatim, because that is the only figure guaranteed to match it
   * exactly. Anything else is converted through the mint's live multiplier and rounded down, so a
   * typed size can never ask for units the account does not have.
   */
  const sellRaw = useMemo(() => {
    if (direction !== "sell" || !valid) return null;
    // Until the mint has answered, any conversion would silently assume a multiplier of 1 and size
    // the sale wrong by exactly the rebase. Better to price nothing for a moment.
    if (rwaLoadedFor !== ticker) return null;
    if (maxed && holding) return holding.raw;
    return sharesToRaw(amountNum, RWA_DECIMALS, multiplier);
  }, [direction, valid, maxed, holding, amountNum, multiplier, rwaLoadedFor, ticker]);

  // --- Pricing ----------------------------------------------------------------------------------

  const planKey =
    direction === "buy"
      ? valid
        ? `buy|${baseMint}|${ticker}|${amountNum}`
        : null
      : sellRaw
        ? `sell|${ticker}|${sellRaw}|${baseMint}`
        : null;

  /**
   * The plan and the request it answers, stored together.
   *
   * Keeping the key alongside the result means "still pricing" is derived by comparing it to what
   * is being asked for now, rather than flipping a loading flag from inside an effect - which is
   * both simpler and avoids a cascading render on every keystroke.
   */
  const [settled, setSettled] = useState<{
    key: string;
    plan: PlanView | null;
    error: string | null;
  } | null>(null);

  const seq = useRef(0);
  useEffect(() => {
    if (!planKey) return;
    const mine = ++seq.current;

    const timer = setTimeout(async () => {
      try {
        const token = { mint: baseMint, symbol: baseSymbol, decimals: baseDecimals };
        const url =
          direction === "buy"
            ? `/api/crosschain/plan?${buyParams(token, ticker, amountNum, owner ?? undefined)}`
            : `/api/crosschain/sell?${sellParams(token, ticker, sellRaw!, amountNum, owner ?? undefined)}`;

        const json = await fetch(url).then((r) => r.json());
        if (seq.current !== mine) return;

        setSettled(
          json.error
            ? {
                key: planKey,
                plan: null,
                error: json.hint ? `${json.error} - ${json.hint}` : json.error,
              }
            : { key: planKey, plan: toView(direction, json, ticker, baseSymbol), error: null },
        );
      } catch (e) {
        if (seq.current === mine) {
          setSettled({
            key: planKey,
            plan: null,
            error: e instanceof Error ? e.message : "could not plan the route",
          });
        }
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [planKey, direction, baseMint, baseSymbol, baseDecimals, ticker, amountNum, sellRaw, owner]);

  const current = planKey && settled?.key === planKey ? settled : null;
  const plan = current?.plan ?? null;
  const planError = current?.error ?? null;
  const pricing =
    (planKey !== null && current === null) ||
    (direction === "sell" && valid && rwaLoadedFor !== ticker);

  // --- Running ----------------------------------------------------------------------------------

  /** Every state change from the executor lands here: persisted, then rendered. */
  const persist = useCallback((j: Journey): Journey => {
    // A finished route is history, not state. It stays on screen for this visit and is gone on the
    // next one, so a reload never offers to resume something that already settled.
    if (j.status === "done") clearJourney(j.owner, j.pairSlug);
    const stored = j.status === "done" ? j : saveJourney(j);
    setJourney(stored);
    return stored;
  }, []);

  const drive = useCallback(
    async (j: Journey) => {
      if (!publicKey || !signTransaction) return;
      setRunning(true);
      try {
        await runJourney(j, {
          cookieConn: connection,
          solanaConn,
          owner: publicKey,
          signTransaction,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
          onChange: persist,
        });
      } finally {
        setRunning(false);
      }
    },
    [publicKey, signTransaction, connection, solanaConn, persist],
  );

  const start = useCallback(() => {
    if (!owner || !plan) return;
    void drive(
      newJourney({
        direction,
        owner,
        pairSlug: pair.slug,
        ticker: pair.quote.ticker,
        rwaMint: pair.quote.mint,
        rwaDecimals: RWA_DECIMALS,
        token: {
          mint: pair.base.mint,
          symbol: pair.base.symbol,
          decimals: pair.base.decimals,
        },
        input:
          direction === "buy"
            ? { amount: amountNum, symbol: pair.base.symbol }
            : { amount: amountNum, symbol: pair.quote.symbol, amountRaw: sellRaw ?? undefined },
        legs: plan.legs,
      }),
    );
  }, [owner, plan, direction, pair, amountNum, sellRaw, drive]);

  const reset = useCallback(() => {
    if (owner) clearJourney(owner, pair.slug);
    setJourney(null);
    setInput("");
    setMaxed(false);
  }, [owner, pair.slug]);

  // --- Render -----------------------------------------------------------------------------------

  const buy = direction === "buy";
  const sellSymbol = buy ? pair.base.symbol : pair.quote.symbol;
  const legs = journey ? journey.legs : (plan?.legs ?? []);

  /**
   * A route that failed before anything was signed is a failed attempt, not a stuck one. The
   * usual case is a rejected wallet prompt, and telling that user where their funds are would be
   * answering a question they did not ask. The leg's own error is already on screen.
   */
  const stuck = journey?.status === "interrupted" && hasTouchedChain(journey);
  const failedToStart = journey?.status === "interrupted" && !stuck;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 pb-3 pt-5">
        <div className="text-[15px] font-medium text-primary">
          {buy ? `Settle into ${pair.quote.symbol}` : `Settle back into ${pair.base.symbol}`}
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          {buy
            ? `Exit ${pair.base.symbol} into real ${pair.quote.symbol} on Solana. Three legs, three signatures, your wallet throughout.`
            : `Sell your ${pair.quote.symbol} on Solana and land back in ${pair.base.symbol}. The same route, run backwards.`}
        </p>
      </div>

      <div className="space-y-3 p-4 pt-1">
        {SOLANA_RPC_IS_PUBLIC && (
          <Notice tone="note">
            No dedicated Solana RPC is configured, so the Solana legs cannot be signed from this
            browser. Coorwa reads what it can through its own server, and pricing below is live, but
            settling needs <span className="num">NEXT_PUBLIC_SOLANA_RPC_URL</span> set.
          </Notice>
        )}

        <div className="segmented w-full">
          <button
            onClick={() => setDirection("buy")}
            data-active={buy}
            disabled={running}
            className="flex-1"
          >
            Buy {pair.quote.symbol}
          </button>
          <button
            onClick={() => setDirection("sell")}
            data-active={!buy}
            disabled={running}
            className="flex-1"
          >
            Sell {pair.quote.symbol}
          </button>
        </div>

        <div className="panel p-4">
          <div className="label mb-2 text-[12px]">Sell</div>
          <div className="flex items-center gap-3">
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value.replace(/[^0-9.]/g, ""));
                setMaxed(false);
              }}
              inputMode="decimal"
              placeholder="0"
              disabled={running}
              className="num w-full bg-transparent text-[26px] text-primary outline-none placeholder:text-[color:var(--text-subtle)] disabled:opacity-50"
            />
            <span className="pill shrink-0 bg-[var(--surface)] text-primary">{sellSymbol}</span>
          </div>

          {!buy && (
            <div className="mt-2.5 flex items-center justify-between gap-3 text-[12px]">
              <span className="num truncate text-muted">
                {holding
                  ? `${fmtAmount(holding.shares, 8)} ${pair.quote.symbol} on Solana`
                  : publicKey
                    ? `No ${pair.quote.symbol} in this wallet`
                    : "Connect a wallet to see your balance"}
              </span>
              {holding && !running && (
                <div className="flex shrink-0 gap-1">
                  {([0.25, 0.5, 1] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => {
                        setInput(trimShares(holding.shares * f));
                        setMaxed(f === 1);
                      }}
                      className="rounded-full px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-[var(--surface)] hover:text-[color:var(--text-primary)]"
                    >
                      {f === 1 ? "Max" : `${f * 100}%`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {pricing && !plan && !journey && <div className="skeleton h-24 w-full" />}

        {plan && !journey && (
          <div className="panel p-4">
            <div className="label text-[12px]">You end up holding</div>
            <div className="num mt-1.5 flex items-baseline gap-2">
              <span className="text-[26px] text-primary">
                {plan.outAmount < 0.0001 ? plan.outAmount.toExponential(4) : plan.outAmount.toFixed(6)}
              </span>
              <span className="text-[14px] text-muted">{plan.outSymbol}</span>
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {usd(plan.outUsd ?? plan.outAmount * pair.base.priceUsd)} · {plan.outWhere}
            </div>
          </div>
        )}

        {legs.length > 0 && <RouteSteps legs={legs} steps={journey?.steps} />}

        {plan && !journey && (
          <div className="flex items-center justify-between px-1 text-[13px]">
            <span className="text-muted">Total slippage</span>
            <span
              className="num"
              style={{
                color: plan.totalPriceImpactPct > 3 ? "var(--color-down)" : "var(--text-primary)",
              }}
            >
              {plan.totalPriceImpactPct.toFixed(2)}%
            </span>
          </div>
        )}

        {stuck && journey && (
          <Notice tone="down">
            <div className="font-medium">
              This route stopped {timeAgo(journey.updatedAt)} ago, at leg {journey.cursor + 1} of{" "}
              {journey.legs.length}.
            </div>
            <p className="mt-1">{fundsLocation(journey)}</p>
            {journey.messageId && (
              <p className="num mt-1">Hyperlane message {shortAddr(journey.messageId, 8)}</p>
            )}
            <p className="mt-1">
              Resuming re-checks every signature it already has before sending anything, so a leg
              that landed is never paid for twice.
            </p>
          </Notice>
        )}

        {journey?.status === "done" && (
          <Notice tone="up">
            The route settled in full. Every leg above links to its transaction.
          </Notice>
        )}

        {!journey && plan?.warnings.map((w, i) => <Notice key={i} tone="note">{w}</Notice>)}

        {planError && !journey && <Notice tone="down">{planError}</Notice>}

        {!publicKey ? (
          <button className="btn btn-primary w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : stuck && journey ? (
          <div className="flex gap-2">
            <button
              className="btn btn-primary flex-1"
              disabled={running}
              onClick={() => void drive(journey)}
            >
              {running ? "Resuming" : `Resume from leg ${journey.cursor + 1}`}
            </button>
            <button className="btn shrink-0" disabled={running} onClick={reset}>
              Discard
            </button>
          </div>
        ) : failedToStart && journey ? (
          <div className="flex gap-2">
            <button
              className="btn btn-primary flex-1"
              disabled={running}
              onClick={() => void drive(journey)}
            >
              {running ? "Routing" : "Try again"}
            </button>
            <button className="btn shrink-0" disabled={running} onClick={reset}>
              Start over
            </button>
          </div>
        ) : journey?.status === "done" ? (
          <button className="btn btn-primary w-full" onClick={reset}>
            Start another
          </button>
        ) : (
          <button
            className="btn btn-primary w-full"
            disabled={!plan || running || pricing}
            onClick={start}
          >
            {running
              ? "Routing"
              : buy
                ? `Settle into ${pair.quote.symbol}`
                : `Sell ${pair.quote.symbol} for ${pair.base.symbol}`}
          </button>
        )}

        {stuck && (
          <p className="px-1 text-[12px] leading-relaxed text-muted">
            Discard only forgets this route. It does not move anything - if the bridge has already
            dispatched, that COOK is still yours and still on its way.
          </p>
        )}
      </div>
    </div>
  );
}

// --- Request and response shapes ------------------------------------------------------------------

interface TokenSide {
  mint: string;
  symbol: string;
  decimals: number;
}

function buyParams(token: TokenSide, ticker: string, amount: number, owner?: string): string {
  const params = new URLSearchParams({
    inputMint: token.mint,
    inputSymbol: token.symbol,
    inputDecimals: String(token.decimals),
    amount: String(amount),
    ticker,
  });
  if (owner) params.set("owner", owner);
  return params.toString();
}

function sellParams(
  token: TokenSide,
  ticker: string,
  amountRaw: string,
  shares: number,
  owner?: string,
): string {
  const params = new URLSearchParams({
    ticker,
    amountRaw,
    shares: String(shares),
    outputMint: token.mint,
    outputSymbol: token.symbol,
    outputDecimals: String(token.decimals),
  });
  if (owner) params.set("owner", owner);
  return params.toString();
}

/**
 * The two planners answer with different shapes because they mean different things: one ends in
 * RWA shares on Solana, the other in tokens on Cookie Chain. This is the only place that difference
 * has to be known.
 */
function toView(
  direction: JourneyDirection,
  json: unknown,
  ticker: string,
  baseSymbol: string,
): PlanView {
  const raw = json as {
    legs: RouteLeg[];
    totalPriceImpactPct: number;
    warnings: string[];
    outputShares?: number;
    outputUsd?: number;
    output?: { amount: number; symbol: string };
  };

  if (direction === "buy") {
    return {
      legs: raw.legs,
      outAmount: raw.outputShares ?? 0,
      outSymbol: `${ticker}x`,
      // Already valued server-side, against the same RWA price the rest of the page is quoting.
      outUsd: raw.outputUsd ?? 0,
      outWhere: "on Solana mainnet",
      totalPriceImpactPct: raw.totalPriceImpactPct,
      warnings: raw.warnings,
    };
  }

  return {
    legs: raw.legs,
    outAmount: raw.output?.amount ?? 0,
    outSymbol: raw.output?.symbol ?? baseSymbol,
    // Valued at the token's own spot price rather than at what was sold: what the user ends up
    // holding is the honest number, and the two differ by exactly the route's slippage.
    outUsd: null,
    outWhere: "on Cookie Chain",
    totalPriceImpactPct: raw.totalPriceImpactPct,
    warnings: raw.warnings,
  };
}

/** A percentage of a rebased balance is a long float. Show it at the mint's own precision. */
function trimShares(n: number): string {
  return n.toFixed(RWA_DECIMALS).replace(/\.?0+$/, "");
}
