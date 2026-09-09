"use client";

/**
 * Cross-chain settlement: turn a Cookie Chain token into a real xStock position on Solana.
 *
 * Three legs, executed as three separate signatures, because they genuinely are three transactions
 * on two chains. The stepper is not decoration - the bridge leg is asynchronous, so the user needs
 * to see exactly where their funds are while a relayer works.
 *
 * Corwa deliberately never wraps an xStock onto Cookie Chain. Those mints carry a permanent
 * delegate, a pause authority and a live rebase multiplier, so a wrapped representation could be
 * seized, frozen or drift off its backing. Routing into the user's own Solana wallet avoids that.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  COOK_MINT,
  COOK_DECIMALS,
  COOK_SOLANA_DECIMALS,
  SOLANA_RPC_URL,
  cookieTxUrl,
  solanaTxUrl,
} from "@/lib/config";
import { amount as fmtAmount, usd, uiToRaw, rawToUi, shortAddr } from "@/lib/format";
import { decodeTx, signSendConfirm, explainError } from "@/lib/tx";
import { buildBridgeTransfer, messageIdFromLogs } from "@/lib/bridge";
import { Notice } from "./notice";
import type { CorwaPair } from "@/lib/pairs";
import type { RouteLeg } from "@/lib/crosschain";

interface Plan {
  legs: RouteLeg[];
  outputShares: number;
  outputUsd: number;
  totalPriceImpactPct: number;
  etaSeconds: number;
  warnings: string[];
  error?: string;
  hint?: string;
}

type StepState = "idle" | "running" | "done" | "failed";

interface StepResult {
  state: StepState;
  signature?: string;
  chain?: "cookie" | "solana";
  detail?: string;
  error?: string;
}

export function CrossChainPanel({ pair }: { pair: CorwaPair }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [input, setInput] = useState("");
  /**
   * The plan and the request it answers, stored together.
   *
   * Keeping the key alongside the result means "still planning" is derived by comparing it to what
   * is being asked for now, rather than flipping a loading flag from inside an effect - which is
   * both simpler and avoids a cascading render on every keystroke.
   */
  const [settled, setSettled] = useState<{
    key: string;
    plan: Plan | null;
    error: string | null;
  } | null>(null);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [running, setRunning] = useState(false);
  /** COOK that actually arrived on Solana, carried from leg 2 into leg 3. */
  const [bridgedCook, setBridgedCook] = useState<number | null>(null);

  const amountNum = Number(input);
  const valid = Number.isFinite(amountNum) && amountNum > 0;

  // The Solana leg needs its own connection: the wallet's provider points at Cookie Chain.
  const solanaConn = useMemo(() => new Connection(SOLANA_RPC_URL, "confirmed"), []);

  const key = valid ? `${pair.base.mint}|${pair.quote.ticker}|${amountNum}` : null;

  const seq = useRef(0);
  useEffect(() => {
    if (!valid || !key) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          inputMint: pair.base.mint,
          inputSymbol: pair.base.symbol,
          inputDecimals: String(pair.base.decimals),
          amount: String(amountNum),
          ticker: pair.quote.ticker,
        });
        if (publicKey) params.set("owner", publicKey.toBase58());
        const res = await fetch(`/api/crosschain/plan?${params}`);
        const json: Plan = await res.json();
        if (seq.current !== mine) return;
        setSettled(
          json.error
            ? { key, plan: null, error: json.hint ? `${json.error} - ${json.hint}` : json.error }
            : { key, plan: json, error: null },
        );
      } catch (e) {
        if (seq.current === mine) {
          setSettled({
            key,
            plan: null,
            error: e instanceof Error ? e.message : "could not plan the route",
          });
        }
      }
    }, 450);
    return () => clearTimeout(t);
  }, [amountNum, valid, key, pair, publicKey]);

  const current = key && settled?.key === key ? settled : null;
  const activePlan = current?.plan ?? null;
  const activePlanError = current?.error ?? null;
  const planning = key !== null && current === null;

  const setStep = useCallback((i: number, patch: Partial<StepResult>) => {
    setSteps((prev) => {
      const next = [...prev];
      next[i] = { ...(next[i] ?? { state: "idle" }), ...patch };
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    if (!publicKey || !signTransaction || !activePlan) return;
    setRunning(true);
    setSteps([{ state: "running" }, { state: "idle" }, { state: "idle" }]);

    try {
      // --- Leg 1: sell the token for COOK on Cookie Chain ---
      const built = await fetch("/api/swap/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          aggregator: "cookiebox",
          owner: publicKey.toBase58(),
          inputMint: pair.base.mint,
          outputMint: COOK_MINT,
          amount: uiToRaw(amountNum, pair.base.decimals),
          slippageBps: 500,
        }),
      }).then((r) => r.json());
      if (built.error) throw new Error(built.error);

      const before = await connection.getBalance(publicKey);
      const swapRes = await signSendConfirm(
        connection,
        decodeTx(built.transactionBase64),
        signTransaction,
      );
      setStep(0, { state: "done", signature: swapRes.signature, chain: "cookie" });

      // Measure what actually landed rather than trusting the quote.
      const after = await connection.getBalance(publicKey);
      const gained = Math.max(0, (after - before) / 10 ** COOK_DECIMALS);
      const toBridge = Math.max(0, gained - 0.01); // headroom for the bridge tx fee

      if (toBridge <= 0) throw new Error("The swap produced no spendable COOK to bridge.");

      // --- Leg 2: bridge COOK to Solana over Hyperlane ---
      setStep(1, { state: "running", detail: `Bridging ${fmtAmount(toBridge)} COOK` });

      const bridge = await buildBridgeTransfer({
        direction: "cookie-to-solana",
        cookieConn: connection,
        solanaConn: solanaConn,
        sender: publicKey,
        recipient: publicKey,
        amountRaw: BigInt(uiToRaw(toBridge, COOK_DECIMALS)),
      });

      // The route's ata_payer PDA is a shared, silently-drainable dependency. If the recipient has
      // no COOK account yet, create it ourselves on Solana FIRST, so a failure here costs nothing.
      if (bridge.recipientAtaIx) {
        setStep(1, { state: "running", detail: "Creating your COOK account on Solana first" });
        const ataTx = new Transaction().add(bridge.recipientAtaIx);
        const { blockhash } = await solanaConn.getLatestBlockhash("confirmed");
        ataTx.recentBlockhash = blockhash;
        ataTx.feePayer = publicKey;
        await signSendConfirm(solanaConn, ataTx, signTransaction);
      }

      setStep(1, { state: "running", detail: "Dispatching over Hyperlane" });
      const signedBridge = await signTransaction(bridge.transaction);
      const bridgeSig = await connection.sendRawTransaction(signedBridge.serialize(), {
        maxRetries: 3,
      });
      const bh = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction(
        {
          signature: bridgeSig,
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
        },
        "confirmed",
      );

      const parsed = await connection.getTransaction(bridgeSig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const msgId = messageIdFromLogs(parsed?.meta?.logMessages);

      setStep(1, {
        state: "done",
        signature: bridgeSig,
        chain: "cookie",
        detail: msgId ? `Hyperlane message ${shortAddr(msgId, 8)}` : "Dispatched",
      });

      // --- Leg 3: wait for delivery, then buy the xStock on Solana ---
      setStep(2, { state: "running", detail: "Waiting for the relayer to deliver on Solana" });

      const delivered = await waitForCookOnSolana(
        solanaConn,
        publicKey,
        toBridge,
        (elapsed) =>
          setStep(2, { state: "running", detail: `Waiting for delivery on Solana (${elapsed}s)` }),
      );

      setBridgedCook(delivered);
      setStep(2, {
        state: "running",
        detail: `Buying ${pair.quote.symbol} with ${fmtAmount(delivered)} COOK`,
      });

      const solLeg = await fetch("/api/crosschain/solana-swap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticker: pair.quote.ticker,
          amount: delivered,
          owner: publicKey.toBase58(),
          slippageBps: 500,
          direction: "buy",
        }),
      }).then((r) => r.json());
      if (solLeg.error) throw new Error(solLeg.error);

      const solRes = await signSendConfirm(
        solanaConn,
        decodeTx(solLeg.transactionBase64),
        signTransaction,
      );

      setStep(2, {
        state: "done",
        signature: solRes.signature,
        chain: "solana",
        detail: `${fmtAmount(rawToUi(solLeg.outAmount, solLeg.outDecimals), 8)} ${pair.quote.symbol} in your wallet`,
      });
    } catch (e) {
      const msg = explainError(e);
      setSteps((prev) => {
        const next = [...prev];
        const i = next.findIndex((s) => s?.state === "running");
        if (i >= 0) next[i] = { ...next[i], state: "failed", error: msg };
        return next;
      });
    } finally {
      setRunning(false);
    }
  }, [publicKey, signTransaction, activePlan, pair, amountNum, connection, setStep, solanaConn]);

  return (
    <div className="card overflow-hidden">
      <div className="px-5 pb-3 pt-5">
        <div className="text-[15px] font-medium text-primary">
          Settle into {pair.quote.symbol}
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          Exit {pair.base.symbol} into real {pair.quote.symbol} on Solana. Three legs, three
          signatures, your wallet throughout.
        </p>
      </div>

      <div className="space-y-3 p-4 pt-1">
        <div className="panel p-4">
          <div className="label mb-2 text-[12px]">Sell</div>
          <div className="flex items-center gap-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0"
              disabled={running}
              className="num w-full bg-transparent text-[26px] text-primary outline-none placeholder:text-[color:var(--text-subtle)] disabled:opacity-50"
            />
            <span className="pill shrink-0 bg-[var(--surface)] text-primary">
              {pair.base.symbol}
            </span>
          </div>
        </div>

        {planning && !activePlan && <div className="skeleton h-24 w-full" />}

        {activePlan && (
          <>
            <div className="panel p-4">
              <div className="label text-[12px]">You end up holding</div>
              <div className="num mt-1.5 flex items-baseline gap-2">
                <span className="text-[26px] text-primary">
                  {activePlan.outputShares < 0.0001
                    ? activePlan.outputShares.toExponential(4)
                    : activePlan.outputShares.toFixed(6)}
                </span>
                <span className="text-[14px] text-muted">{pair.quote.symbol}</span>
              </div>
              <div className="mt-1 text-[12px] text-muted">
                {usd(activePlan.outputUsd)} · on Solana mainnet
              </div>
            </div>

            <ol className="space-y-2">
              {activePlan.legs.map((leg, i) => (
                <LegRow key={i} index={i} leg={leg} result={steps[i]} />
              ))}
            </ol>

            <div className="flex items-center justify-between px-1 text-[13px]">
              <span className="text-muted">Total slippage</span>
              <span
                className="num"
                style={{
                  color:
                    activePlan.totalPriceImpactPct > 3 ? "var(--color-down)" : "var(--text-primary)",
                }}
              >
                {activePlan.totalPriceImpactPct.toFixed(2)}%
              </span>
            </div>

            {activePlan.warnings.map((w, i) => (
              <Notice key={i} tone="note">
                {w}
              </Notice>
            ))}
          </>
        )}

        {activePlanError && <Notice tone="down">{activePlanError}</Notice>}

        {!publicKey ? (
          <button className="btn btn-primary w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary w-full"
            disabled={!activePlan || running || planning}
            onClick={run}
          >
            {running ? "Routing" : `Settle into ${pair.quote.symbol}`}
          </button>
        )}

        {bridgedCook != null && (
          <p className="px-1 text-[12px] text-muted">
            {fmtAmount(bridgedCook)} COOK arrived on Solana.
          </p>
        )}
      </div>
    </div>
  );
}

function LegRow({ index, leg, result }: { index: number; leg: RouteLeg; result?: StepResult }) {
  const state = result?.state ?? "idle";
  const mark =
    state === "done" ? "✓" : state === "failed" ? "✕" : state === "running" ? "•" : String(index + 1);

  const markStyle: React.CSSProperties =
    state === "done"
      ? { background: "color-mix(in srgb, var(--color-up) 16%, transparent)", color: "var(--color-up)" }
      : state === "failed"
        ? {
            background: "color-mix(in srgb, var(--color-down) 16%, transparent)",
            color: "var(--color-down)",
          }
        : state === "running"
          ? { background: "var(--accent-tint)", color: "var(--color-cookie-deep)" }
          : { background: "var(--surface)", color: "var(--text-subtle)" };

  return (
    <li className="panel flex gap-3 p-3.5">
      <span
        style={markStyle}
        className={`num grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] ${
          state === "running" ? "live-dot" : ""
        }`}
      >
        {mark}
      </span>
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="text-primary">{leg.label}</div>
        <div className="truncate text-[12px] text-muted">{leg.venue}</div>
        <div className="num mt-1 text-[12px] text-muted">
          {fmtAmount(leg.inAmount)} {leg.inSymbol} → {fmtAmount(leg.outAmount, 8)} {leg.outSymbol}
          {leg.priceImpactPct ? ` · ${leg.priceImpactPct.toFixed(2)}%` : ""}
        </div>
        {result?.detail && (
          <div className="mt-1 text-[12px] text-[color:var(--color-cookie-deep)]">
            {result.detail}
          </div>
        )}
        {result?.error && (
          <div className="mt-1 text-[12px] text-[color:var(--color-down)]">{result.error}</div>
        )}
        {result?.signature && (
          <a
            href={
              result.chain === "solana"
                ? solanaTxUrl(result.signature)
                : cookieTxUrl(result.signature)
            }
            target="_blank"
            rel="noreferrer"
            className="num mt-1 inline-block text-[12px] text-muted underline underline-offset-4 transition-colors hover:text-[color:var(--text-primary)]"
          >
            {shortAddr(result.signature, 6)}
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * Poll Solana until the bridged COOK shows up.
 *
 * Delivery is a relayer's job, so there is no receipt to await - the only reliable signal is the
 * recipient's balance rising. Returns what actually arrived, which is what leg 3 must spend.
 */
async function waitForCookOnSolana(
  conn: Connection,
  owner: PublicKey,
  expected: number,
  onTick: (elapsedSeconds: number) => void,
  timeoutMs = 15 * 60_000,
): Promise<number> {
  const { COOK_SOLANA_MINT } = await import("@/lib/config");
  const mint = new PublicKey(COOK_SOLANA_MINT);
  const started = Date.now();
  let baseline: number | null = null;

  while (Date.now() - started < timeoutMs) {
    let balance = 0;
    try {
      const accounts = await conn.getParsedTokenAccountsByOwner(owner, { mint });
      balance = accounts.value.reduce(
        (sum, a) => sum + (a.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0),
        0,
      );
    } catch {
      // A throttled public RPC is expected here; keep waiting rather than failing the transfer.
    }

    if (baseline === null) baseline = balance;
    const gained = balance - baseline;
    // Accept once most of the expected amount has landed; the bridge takes interchain gas out.
    if (gained >= expected * 0.9) return Number(gained.toFixed(COOK_SOLANA_DECIMALS));

    onTick(Math.round((Date.now() - started) / 1000));
    await new Promise((r) => setTimeout(r, 6_000));
  }

  throw new Error(
    "The bridge has not delivered within 15 minutes. Your COOK is not lost - it is locked in the " +
      "warp route and will arrive when a relayer picks it up. Reopen this panel then to finish leg 3.",
  );
}
