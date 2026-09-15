"use client";

/**
 * Money Coorwa pays out, taken as a stock rather than as it arrives.
 *
 * Two things pay out today: cashback out of the vault, and the fees on an LP position. Both are the
 * settlement panel's cross-chain buy with a claim as its first leg, so this component runs either
 * as one journey: claim into the wallet, bridge the COOK to Solana, buy the chosen xStock there into
 * the same wallet. A payout that stops after the bridge resumes from the middle like any route.
 *
 * Two checks come before the first signature, because either failure would leave COOK sitting on
 * Solana halfway: the payout has to be worth its fixed costs, and the wallet has to hold the SOL the
 * Solana side pays. See `lib/payout.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import {
  COOK_DECIMALS,
  COOK_MINT,
  COOK_SYMBOL,
  DEFAULT_SLIPPAGE_BPS,
  SOLANA_RPC_IS_PUBLIC,
  SOLANA_RPC_URL,
} from "@/lib/config";
import { DEFAULT_RWA, RWA_ASSETS, RWA_DECIMALS, rwaByTicker } from "@/lib/rwa";
import { amount as fmtAmount, shortAddr, timeAgo, usd } from "@/lib/format";
import {
  clearJourney,
  fundsLocation,
  hasTouchedChain,
  isResumable,
  loadJourney,
  newJourney,
  saveJourney,
  type Journey,
} from "@/lib/journey";
import { runJourney } from "@/lib/crosschain-exec";
import {
  PAYOUT_SLUG,
  claimLeg,
  payoutBlocked,
  solanaReadiness,
  type LpClaim,
  type PayoutClaim,
  type SolanaReadiness,
} from "@/lib/payout";
import { RouteSteps } from "./route-steps";
import { Notice } from "./notice";
import type { ClaimableLine } from "@/lib/epochs";
import type { RouteLeg } from "@/lib/crosschain";

interface PayoutPlan {
  legs: RouteLeg[];
  outShares: number;
  outUsd: number;
  impactPct: number;
  note: string | null;
}

/**
 * One way of pricing the payout. A payout may offer several, tried in order until one prices: an
 * LP claim first tries selling both sides, then falls back to its COOK side alone when the other
 * side is too small for any route.
 */
export interface PayoutPricing {
  /** Where the Cookie Chain side of the route starts: COOK itself, or a token sold for it. */
  inputMint: string;
  inputSymbol: string;
  inputDecimals: number;
  amount: number;
  /** COOK joining the route after the swap, see `planCrossChainBuy`. */
  plusCook?: number;
  firstLeg: RouteLeg;
  /** Said under the estimate when this pricing is the one used. */
  note?: string;
}

export interface PayoutSpec {
  /** Journey key in place of a pair, so each payout resumes on its own. */
  slug: string;
  source: "cashback" | "lp-fees";
  /** What is owed, in COOK, for the "nothing yet" check. Only its sign matters to the gate. */
  owedCook: number;
  pricings: PayoutPricing[];
  /** The Cookie Chain side the journey records: COOK for cashback, the pool's token for LP fees. */
  token: { mint: string; symbol: string; decimals: number };
  input: { amount: number; symbol: string };
  claims?: PayoutClaim[];
  lpClaim?: LpClaim;
  copy: {
    title: string;
    body: string;
    /** Button label, with the stock's symbol appended. */
    action: string;
    done: string;
    /** How a resume avoids paying twice, for the stuck notice. */
    resumeSafety: string;
  };
}

export function RwaPayout({ open, onSettled }: { open: ClaimableLine[]; onSettled: () => void }) {
  const owedCook = useMemo(() => open.reduce((sum, l) => sum + l.amountCook, 0), [open]);
  const spec = useMemo<PayoutSpec>(
    () => ({
      slug: PAYOUT_SLUG,
      source: "cashback",
      owedCook,
      pricings:
        owedCook > 0
          ? [
              {
                inputMint: COOK_MINT,
                inputSymbol: COOK_SYMBOL,
                inputDecimals: COOK_DECIMALS,
                amount: owedCook,
                firstLeg: claimLeg(owedCook),
              },
            ]
          : [],
      token: { mint: COOK_MINT, symbol: COOK_SYMBOL, decimals: COOK_DECIMALS },
      input: { amount: owedCook, symbol: COOK_SYMBOL },
      claims: open.map((l) => ({ epoch: l.epoch, amountRaw: l.amountRaw, proof: l.proof })),
      copy: {
        title: "Take it as a stock",
        body:
          "Claim, bridge the COOK to Solana, and buy a real xStock into this same wallet there. " +
          "Each step is its own signature, and a payout that stops halfway picks up where it left off.",
        action: "Claim as",
        done: "Paid out in full.",
        resumeSafety:
          "Resuming checks what already landed before sending anything, and the vault refuses a " +
          "second claim of the same epoch, so nothing is paid twice.",
      },
    }),
    [owedCook, open],
  );

  return <StockPayout spec={spec} hidden={open.length === 0} onSettled={onSettled} />;
}

/**
 * The payout panel itself. `hidden` hides it while there is nothing to pay, unless a payout from an
 * earlier visit is still waiting to be resumed.
 */
export function StockPayout({
  spec,
  hidden = false,
  onSettled,
}: {
  spec: PayoutSpec;
  hidden?: boolean;
  onSettled: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  // The Solana legs need their own connection: the wallet's provider points at Cookie Chain.
  const solanaConn = useMemo(() => new Connection(SOLANA_RPC_URL, "confirmed"), []);

  const [ticker, setTicker] = useState(DEFAULT_RWA.ticker);
  const asset = rwaByTicker(ticker) ?? DEFAULT_RWA;
  const [journey, setJourney] = useState<Journey | null>(null);
  const [running, setRunning] = useState(false);

  const owner = publicKey?.toBase58() ?? null;
  const { slug } = spec;

  // --- A payout left over from a previous visit -------------------------------------------------

  // Restored during render, as the settlement panel does, so the page never paints once without it.
  const restoreKey = owner ? `${owner}|${slug}` : null;
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  if (restoredFor !== restoreKey) {
    setRestoredFor(restoreKey);
    const stored = owner ? loadJourney(owner, slug) : null;
    if (isResumable(stored)) {
      // Nothing is driving a route stored as "running" any more; the tab that ran it is gone.
      setJourney({ ...stored, status: "interrupted" });
      setTicker(stored.ticker);
    } else {
      setJourney(null);
    }
  }

  // --- Pricing: the same planner as a settlement ------------------------------------------------

  const planKey =
    spec.pricings.length > 0
      ? JSON.stringify([ticker, spec.pricings.map((p) => [p.inputMint, p.amount, p.plusCook ?? 0])])
      : null;
  const [priced, setPriced] = useState<{
    key: string;
    plan: PayoutPlan | null;
    error: string | null;
  } | null>(null);

  const pricings = spec.pricings;
  useEffect(() => {
    if (!planKey) return;
    let cancelled = false;

    (async () => {
      let error = "could not price the payout";
      for (const p of pricings) {
        try {
          const params = new URLSearchParams({
            inputMint: p.inputMint,
            inputSymbol: p.inputSymbol,
            inputDecimals: String(p.inputDecimals),
            amount: String(p.amount),
            ticker,
          });
          if (p.plusCook) params.set("plusCook", String(p.plusCook));
          if (owner) params.set("owner", owner);
          const json = await fetch(`/api/crosschain/plan?${params}`).then((r) => r.json());
          if (cancelled) return;

          if (json.error) {
            error = json.hint ? `${json.error} - ${json.hint}` : json.error;
            continue;
          }
          if (!(json.outputUsd > 0)) {
            // Without a price the floor cannot be applied, and a guess would be the wrong way round.
            // A fallback would not read the price any better, so stop here.
            setPriced({
              key: planKey,
              plan: null,
              error:
                "The stock's price could not be read, so the payout cannot be valued. Try again shortly.",
            });
            return;
          }
          setPriced({
            key: planKey,
            plan: {
              legs: [p.firstLeg, ...json.legs],
              outShares: json.outputShares,
              outUsd: json.outputUsd,
              impactPct: json.totalPriceImpactPct,
              note: p.note ?? null,
            },
            error: null,
          });
          return;
        } catch (e) {
          if (cancelled) return;
          error = e instanceof Error ? e.message : error;
        }
      }
      setPriced({ key: planKey, plan: null, error });
    })();

    return () => {
      cancelled = true;
    };
    // `pricings` is described completely by `planKey`; a new array with the same key is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, ticker, owner]);

  const current = planKey && priced?.key === planKey ? priced : null;
  const plan = current?.plan ?? null;
  const planError = current?.error ?? null;

  // --- The Solana side: SOL for fees, and the accounts a first payout opens ----------------------

  /** Bumped by "Check again", so a wallet that has just been topped up is read afresh. */
  const [recheck, setRecheck] = useState(0);
  const readyKey = owner && !SOLANA_RPC_IS_PUBLIC ? `${owner}|${asset.mint}|${recheck}` : null;
  const [ready, setReady] = useState<{ key: string; sol: SolanaReadiness | null } | null>(null);

  useEffect(() => {
    if (!readyKey || !publicKey) return;
    let cancelled = false;
    solanaReadiness(solanaConn, publicKey, asset.mint).then(
      (sol) => {
        if (!cancelled) setReady({ key: readyKey, sol });
      },
      () => {
        if (!cancelled) setReady({ key: readyKey, sol: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [readyKey, publicKey, solanaConn, asset.mint]);

  const sol = ready?.key === readyKey ? ready.sol : null;
  const solShort = sol !== null && sol.balance < sol.needed;

  const blocked = payoutBlocked({
    rpcIsPublic: SOLANA_RPC_IS_PUBLIC,
    owedCook: spec.owedCook,
    valueUsd: plan ? plan.outUsd : null,
    sol,
    source: spec.source,
  });

  // --- Running ----------------------------------------------------------------------------------

  const persist = useCallback((j: Journey): Journey => {
    // A payout that finished is history, so a reload never offers to resume it.
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
        onSettled();
      }
    },
    [publicKey, signTransaction, connection, solanaConn, persist, onSettled],
  );

  const start = useCallback(() => {
    if (!owner || !plan) return;
    void drive(
      newJourney({
        direction: "buy",
        owner,
        pairSlug: slug,
        ticker: asset.ticker,
        rwaMint: asset.mint,
        rwaDecimals: RWA_DECIMALS,
        token: spec.token,
        input: spec.input,
        legs: plan.legs,
        claims: spec.claims,
        lpClaim: spec.lpClaim,
      }),
    );
  }, [owner, plan, asset, slug, spec, drive]);

  const reset = useCallback(() => {
    if (owner) clearJourney(owner, slug);
    setJourney(null);
  }, [owner, slug]);

  // --- Render -----------------------------------------------------------------------------------

  if (!publicKey || (hidden && !journey)) return null;

  const legs = journey ? journey.legs : (plan?.legs ?? []);
  const stuck = journey?.status === "interrupted" && hasTouchedChain(journey);
  const failedToStart = journey?.status === "interrupted" && !stuck;

  return (
    <div className="mt-6 border-t border-hair pt-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] text-primary">{spec.copy.title}</div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">{spec.copy.body}</p>
        </div>
        <label className="shrink-0">
          <span className="sr-only">Stock to receive</span>
          <select
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            disabled={running || journey !== null}
            className="num glass-select rounded-full px-3 py-2 text-[13px] text-primary outline-none disabled:opacity-50"
          >
            {RWA_ASSETS.map((a) => (
              <option key={a.ticker} value={a.ticker}>
                {a.symbol} · {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {plan && !journey && (
        <div className="panel mt-4 p-4">
          <div className="label text-[12px]">You end up holding</div>
          <div className="num mt-1.5 flex items-baseline gap-2">
            <span className="text-[26px] text-primary">{fmtAmount(plan.outShares, 8)}</span>
            <span className="text-[14px] text-muted">{asset.symbol}</span>
          </div>
          <div className="mt-1 text-[12px] text-muted">
            {usd(plan.outUsd)} on Solana mainnet · {plan.impactPct.toFixed(2)}% slippage
          </div>
          {plan.note && <div className="mt-1 text-[12px] text-subtle">{plan.note}</div>}
        </div>
      )}

      {legs.length > 0 && (
        <div className="mt-3">
          <RouteSteps legs={legs} steps={journey?.steps} />
        </div>
      )}

      <div className="mt-3 space-y-3">
        {stuck && journey && (
          <Notice tone="down">
            <div className="font-medium">
              This payout stopped {timeAgo(journey.updatedAt)} ago, at step {journey.cursor + 1} of{" "}
              {journey.legs.length}.
            </div>
            <p className="mt-1">{fundsLocation(journey)}</p>
            {journey.messageId && (
              <p className="num mt-1">Hyperlane message {shortAddr(journey.messageId, 8)}</p>
            )}
            <p className="mt-1">{spec.copy.resumeSafety}</p>
          </Notice>
        )}

        {journey?.status === "done" && (
          <Notice tone="up">
            {spec.copy.done} Your {journey.ticker}x is in your Solana wallet, and every step above
            links to its transaction.
          </Notice>
        )}

        {planError && !journey && <Notice tone="down">{planError}</Notice>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {stuck && journey ? (
          <>
            <button
              className="btn btn-primary"
              disabled={running}
              onClick={() => void drive(journey)}
            >
              {running ? "Resuming" : `Resume from step ${journey.cursor + 1}`}
            </button>
            <button className="btn" disabled={running} onClick={reset}>
              Discard
            </button>
          </>
        ) : failedToStart && journey ? (
          <>
            <button
              className="btn btn-primary"
              disabled={running}
              onClick={() => void drive(journey)}
            >
              {running ? "Paying out" : "Try again"}
            </button>
            <button className="btn" disabled={running} onClick={reset}>
              Start over
            </button>
          </>
        ) : journey?.status === "done" ? (
          <button className="btn" onClick={reset}>
            Done
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={blocked !== null || running}
            onClick={start}
          >
            {running ? "Paying out" : `${spec.copy.action} ${asset.symbol}`}
          </button>
        )}
      </div>

      {!journey && blocked && (
        <p className="mt-3 text-[12px] leading-relaxed text-subtle">
          {blocked}{" "}
          {solShort && (
            <button
              onClick={() => setRecheck((n) => n + 1)}
              className="underline underline-offset-4 transition-colors hover:text-[color:var(--text-primary)]"
            >
              Check again
            </button>
          )}
        </p>
      )}

      {stuck && (
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          Discard only forgets this payout. It moves nothing: whatever was claimed or bridged is
          still yours, and still where the note above says.
        </p>
      )}
    </div>
  );
}
