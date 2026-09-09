"use client";

/**
 * The stepper for a cross-chain route.
 *
 * Not decoration. The bridge leg is asynchronous and the three legs are three separate signatures
 * on two chains, so at any moment the user needs to be able to see which of them have actually
 * happened and where their funds are sitting right now.
 *
 * Each row shows two things that are deliberately different: the leg as it was PRICED, and, once
 * it runs, what it actually produced. A quote is a prediction, so the second line is the one that
 * tells the truth.
 */
import { cookieTxUrl, solanaTxUrl } from "@/lib/config";
import { amount as fmtAmount, shortAddr } from "@/lib/format";
import type { RouteLeg } from "@/lib/crosschain";
import type { JourneyStep } from "@/lib/journey";

export function RouteSteps({ legs, steps }: { legs: RouteLeg[]; steps?: JourneyStep[] }) {
  return (
    <ol className="space-y-2">
      {legs.map((leg, i) => (
        <StepRow key={i} index={i} leg={leg} step={steps?.[i]} />
      ))}
    </ol>
  );
}

function StepRow({ index, leg, step }: { index: number; leg: RouteLeg; step?: JourneyStep }) {
  const state = step?.state ?? "idle";
  const mark =
    state === "done" ? "✓" : state === "failed" ? "✕" : state === "running" ? "•" : String(index + 1);

  const markStyle: React.CSSProperties =
    state === "done"
      ? {
          background: "color-mix(in srgb, var(--color-up) 16%, transparent)",
          color: "var(--color-up)",
        }
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
        {step?.detail && (
          <div className="mt-1 text-[12px] text-[color:var(--color-cookie-deep)]">{step.detail}</div>
        )}
        {step?.error && (
          <div className="mt-1 text-[12px] leading-relaxed text-[color:var(--color-down)]">
            {step.error}
          </div>
        )}
        {step?.signature && (
          <a
            href={step.chain === "solana" ? solanaTxUrl(step.signature) : cookieTxUrl(step.signature)}
            target="_blank"
            rel="noreferrer"
            className="num mt-1 inline-block text-[12px] text-muted underline underline-offset-4 transition-colors hover:text-[color:var(--text-primary)]"
          >
            {shortAddr(step.signature, 6)}
          </a>
        )}
      </div>
    </li>
  );
}
