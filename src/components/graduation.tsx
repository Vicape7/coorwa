"use client";

/**
 * How a curve's graduation looks while it happens: the bar that fills as the raise comes in, the
 * figure above it counting up, and the notice that says the curve has filled and its pool is
 * opening.
 *
 * Both animate between whatever values they are given, so a page that learns about a buy early
 * (its own, read straight off the chain) and one that learns on its next poll show the same
 * movement: the number runs up to its new value while the fill grows to its new width.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TokenMark } from "./token-mark";
import { amount } from "@/lib/format";

/** How long a change takes to play out, the bar and the number together. */
const RISE_MS = 1600;

/**
 * A number that runs to each new value instead of jumping. Starts where it is shown, so a second
 * change arriving mid-run carries on from there.
 */
function useCountUp(target: number, duration = RISE_MS): number {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Timed from the first frame drawn, so a change that lands in a background tab plays out when
    // the tab is looked at again instead of having finished unseen.
    let start = -1;
    let frame = 0;
    const tick = (now: number) => {
      if (start < 0) start = now;
      const t = instant ? 1 : Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      current.current = from + (target - from) * eased;
      setShown(current.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return shown;
}

/** A figure that counts up to each new value, drawn through the caller's own formatting. */
export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  return <>{format(useCountUp(value))}</>;
}

export function GraduationBar({
  progress,
  className = "",
}: {
  /** 0 to 1. */
  progress: number;
  className?: string;
}) {
  const value = Math.max(0, Math.min(1, progress));
  // The last value drawn and the last rise, derived during render so a rise is seen the moment the
  // new value arrives rather than one commit later.
  const [seen, setSeen] = useState(value);
  const [rise, setRise] = useState<{ n: number; from: number } | null>(null);
  if (value !== seen) {
    setSeen(value);
    if (value > seen) setRise({ n: (rise?.n ?? 0) + 1, from: seen });
  }
  const pct = value * 100;
  // Never narrower than its own lit head, so a curve that has barely started still shows one.
  const width = (p: number) => (p > 0 ? `max(${p}%, 8px)` : "0%");

  return (
    <div
      className={`grad-bar ${value >= 1 ? "is-full" : ""} ${className}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(pct)}
    >
      <div className="grad-bar-track">
        {/* What the rise added, lit ahead of the fill, which then grows into it. */}
        {rise && (
          <span
            key={`gain-${rise.n}`}
            className="grad-bar-gain"
            style={{ left: `${rise.from * 100}%`, width: `max(${pct - rise.from * 100}%, 3px)` }}
          />
        )}
        <div className="grad-bar-fill" style={{ width: width(pct) }}>
          {rise && <span key={rise.n} className="grad-bar-sweep" />}
          {value > 0 && <span key={`head-${rise?.n ?? 0}`} className="grad-bar-head" />}
        </div>
      </div>
      {rise && <span key={`halo-${rise.n}`} className="grad-bar-halo" />}
    </div>
  );
}

export interface GraduationEvent {
  /** `graduated` when the curve filled while the page was open, `pooled` when only the pool opened. */
  kind: "graduated" | "pooled";
  /** Whether this wallet's own buy was the one that filled it. */
  mine: boolean;
  id: number;
}

const COLOURS = ["#f0b860", "#d89038", "#f8d080", "#fdf4e6", "#34c759", "#ffffff"];

/** Where each piece falls, fixed once for the module so a render never draws new ones. */
const PIECES = Array.from({ length: 72 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    left: r(1) * 100,
    delay: r(2) * 0.7,
    duration: 2.4 + r(3) * 1.8,
    drift: (r(4) - 0.5) * 220,
    spin: (r(5) - 0.5) * 1440,
    size: 6 + r(6) * 7,
    colour: COLOURS[i % COLOURS.length],
    round: r(7) > 0.72,
  };
});

function Confetti() {
  return (
    <div className="confetti" aria-hidden>
      {PIECES.map((p, i) => (
        <i
          key={i}
          style={
            {
              left: `${p.left}%`,
              "--c": p.colour,
              "--s": `${p.size}px`,
              "--d": `${p.delay}s`,
              "--t": `${p.duration}s`,
              "--x": `${p.drift}px`,
              "--r": `${p.spin}deg`,
              borderRadius: p.round ? "999px" : "2px",
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * The notice a graduation raises, over the page and outside every glass card, since a fixed element
 * inside a backdrop-filtered one is placed against that card instead of the window.
 *
 * It follows the curve rather than the moment it opened: it says the pool is opening until the pool
 * is there, then says so and closes itself a little later.
 */
export function GraduationNotice({
  event,
  state,
  symbol,
  logo,
  raisedCook,
  poolHref,
  onClose,
}: {
  event: GraduationEvent;
  state: "live" | "graduated" | "pooled";
  symbol: string;
  logo: string | null;
  raisedCook: number;
  poolHref: string | null;
  onClose: () => void;
}) {
  const pooled = state === "pooled";

  useEffect(() => {
    if (!pooled) return;
    const timer = window.setTimeout(onClose, event.kind === "pooled" ? 8_000 : 12_000);
    return () => window.clearTimeout(timer);
  }, [pooled, event.kind, onClose]);

  const title =
    event.kind === "pooled"
      ? `${symbol} now trades in its pool`
      : event.mine
        ? `Your buy graduated ${symbol}`
        : `${symbol} graduated`;

  return createPortal(
    <>
      {event.kind === "graduated" && <Confetti key={event.id} />}
      <div className="grad-notice" role="status" aria-live="polite">
        <div key={event.id} className="glass-dialog rise p-4 sm:p-5">
          <div className="flex items-start gap-3.5">
            <div className="grad-notice-mark">
              <TokenMark logo={logo} symbol={symbol} size={44} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium leading-snug text-primary">{title}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                {event.kind === "pooled"
                  ? "Its pool is open and locked for good, and the panel trades there now."
                  : `The curve filled at ${amount(raisedCook, 0)} COOK. Coorwa's program opens a pool with it and locks it for good.`}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 rounded-full p-1.5 text-subtle transition-colors hover:text-[color:var(--text-primary)]"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="mt-3.5 flex items-center justify-between gap-3 text-[12px]">
            {pooled ? (
              <span className="flex items-center gap-2 text-[color:var(--color-up)]">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
                  <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Pool is live
              </span>
            ) : (
              <span className="flex items-center gap-2 text-muted">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--color-cookie)]" />
                Opening the pool
              </span>
            )}
            {pooled && poolHref && (
              <a
                href={poolHref}
                target="_blank"
                rel="noreferrer"
                className="text-muted underline underline-offset-4 hover:text-[color:var(--text-primary)]"
              >
                View pool
              </a>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
