"use client";

/**
 * Cashback taken as a stock rather than as COOK.
 *
 * The claim and the cross-chain route existed separately; this runs them as one journey. Every open
 * epoch is claimed into the wallet, the COOK is bridged to Solana, and the chosen xStock is bought
 * there into the same wallet. It is the settlement panel's executor with the claim as its first
 * leg, so a payout that stops after the bridge resumes from the middle like any route.
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
}

export function RwaPayout({ open, onSettled }: { open: ClaimableLine[]; onSettled: () => void }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  // The Solana legs need their own connection: the wallet's provider points at Cookie Chain.
  const solanaConn = useMemo(() => new Connection(SOLANA_RPC_URL, "confirmed"), []);

  const [ticker, setTicker] = useState(DEFAULT_RWA.ticker);
  const asset = rwaByTicker(ticker) ?? DEFAULT_RWA;
  const [journey, setJourney] = useState<Journey | null>(null);
  const [running, setRunning] = useState(false);

  const owner = publicKey?.toBase58() ?? null;
  const owedCook = useMemo(() => open.reduce((sum, l) => sum + l.amountCook, 0), [open]);

  // --- A payout left over from a previous visit -------------------------------------------------

  // Restored during render, as the settlement panel does, so the page never paints once without it.
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  if (restoredFor !== owner) {
    setRestoredFor(owner);
    const stored = owner ? loadJourney(owner, PAYOUT_SLUG) : null;
    if (isResumable(stored)) {
      // Nothing is driving a route stored as "running" any more; the tab that ran it is gone.
      setJourney({ ...stored, status: "interrupted" });
      setTicker(stored.ticker);
    } else {
      setJourney(null);
    }
  }

  // --- Pricing: the same planner as a settlement, starting from COOK ----------------------------

  const planKey = owedCook > 0 ? `${ticker}|${owedCook}` : null;
  const [priced, setPriced] = useState<{
    key: string;
    plan: PayoutPlan | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!planKey) return;
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({
          inputMint: COOK_MINT,
          inputSymbol: COOK_SYMBOL,
          inputDecimals: String(COOK_DECIMALS),
          amount: String(owedCook),
          ticker,
        });
        if (owner) params.set("owner", owner);
        const json = await fetch(`/api/crosschain/plan?${params}`).then((r) => r.json());
        if (cancelled) return;

        if (json.error) {
          setPriced({
            key: planKey,
            plan: null,
            error: json.hint ? `${json.error} - ${json.hint}` : json.error,
          });
        } else if (!(json.outputUsd > 0)) {
          // Without a price the floor cannot be applied, and a guess would be the wrong way round.
          setPriced({
            key: planKey,
            plan: null,
            error:
              "The stock's price could not be read, so the payout cannot be valued. Try again shortly.",
          });
        } else {
          setPriced({
            key: planKey,
            plan: {
              legs: json.legs,
              outShares: json.outputShares,
              outUsd: json.outputUsd,
              impactPct: json.totalPriceImpactPct,
            },
            error: null,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setPriced({
            key: planKey,
            plan: null,
            error: e instanceof Error ? e.message : "could not price the payout",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [planKey, owedCook, ticker, owner]);

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
    owedCook,
    valueUsd: plan ? plan.outUsd : null,
    sol,
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
        pairSlug: PAYOUT_SLUG,
        ticker: asset.ticker,
        rwaMint: asset.mint,
        rwaDecimals: RWA_DECIMALS,
        token: { mint: COOK_MINT, symbol: COOK_SYMBOL, decimals: COOK_DECIMALS },
        input: { amount: owedCook, symbol: COOK_SYMBOL },
        legs: [claimLeg(owedCook), ...plan.legs],
        claims: open.map((l) => ({ epoch: l.epoch, amountRaw: l.amountRaw, proof: l.proof })),
      }),
    );
  }, [owner, plan, asset, owedCook, open, drive]);

  const reset = useCallback(() => {
    if (owner) clearJourney(owner, PAYOUT_SLUG);
    setJourney(null);
  }, [owner]);

  // --- Render -----------------------------------------------------------------------------------

  if (!publicKey || (open.length === 0 && !journey)) return null;

  const legs = journey ? journey.legs : plan ? [claimLeg(owedCook), ...plan.legs] : [];
  const stuck = journey?.status === "interrupted" && hasTouchedChain(journey);
  const failedToStart = journey?.status === "interrupted" && !stuck;

  return (
    <div className="mt-6 border-t border-hair pt-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] text-primary">Or take it as a stock</div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
            Claim, bridge the COOK to Solana, and buy a real xStock into this same wallet there.
            Each step is its own signature, and a payout that stops halfway picks up where it left
            off.
          </p>
        </div>
        <label className="shrink-0">
          <span className="sr-only">Stock to receive</span>
          <select
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            disabled={running || journey !== null}
            className="num rounded-full border border-hair bg-[var(--surface)] px-3 py-2 text-[13px] text-primary outline-none disabled:opacity-50"
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
            <p className="mt-1">
              Resuming checks what already landed before sending anything, and the vault refuses a
              second claim of the same epoch, so nothing is paid twice.
            </p>
          </Notice>
        )}

        {journey?.status === "done" && (
          <Notice tone="up">
            Paid out in full. Your {journey.ticker}x is in your Solana wallet, and every step above
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
            {running ? "Paying out" : `Claim as ${asset.symbol}`}
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
