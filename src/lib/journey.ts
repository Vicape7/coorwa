/**
 * A cross-chain route in progress, and the only honest way to survive a partial failure.
 *
 * A Coorwa settlement is three transactions on two chains with an asynchronous relayer in the
 * middle. That middle leg is the problem. Once the bridge has dispatched, the user's COOK has
 * already left the source chain, so a failure on the last leg is not "the trade did not happen" -
 * it is "the trade is half done and the funds are sitting somewhere else". Showing an error there
 * would be a lie by omission.
 *
 * So the panel does not hold the route in React state alone. Each leg that lands is written to
 * localStorage together with the measurements the next leg needs, and the run can be picked up
 * from the middle - after a failed signature, a closed tab, or a browser restart.
 *
 * Three rules make a resume trustworthy:
 *
 *  1. `cursor` only advances once a leg has actually confirmed on chain. Everything below it is
 *     settled; everything from it upwards still has to happen.
 *  2. Amounts carried across the bridge are MEASURED, never taken from the quote. `bridgeAmount`
 *     is read out of the swap transaction's own balance delta, so a partial fill or an unexpected
 *     fee cannot make the next leg spend money that is not there.
 *  3. `destBaseline` is captured BEFORE the bridge dispatches. Delivery is detected by the
 *     destination balance rising, and a baseline read after the fact would already contain the
 *     delivery - the wait would then never finish. This is exactly the case a resume hits.
 *
 * Storage is keyed by wallet plus pair, so one route can be in flight per pair and a resume can
 * never be offered to a different wallet than the one that signed it.
 */
import type { RouteLeg } from "./crosschain";
import type { CreatorClaim } from "./payout";

export type JourneyDirection = "buy" | "sell";
export type StepState = "idle" | "running" | "done" | "failed";

export interface JourneyStep {
  state: StepState;
  /** Written as soon as the send returns, before confirmation, so a resume can check it on chain. */
  signature?: string;
  chain?: "cookie" | "solana";
  detail?: string;
  error?: string;
}

export interface Journey {
  /** Schema version, so a stored route from an older build is discarded rather than misread. */
  v: 1;
  direction: JourneyDirection;
  /** Wallet that signed leg 1. A resume is only ever offered to this address. */
  owner: string;
  pairSlug: string;
  /** RWA ticker, e.g. "NVDA". */
  ticker: string;
  /**
   * The xStock mint and its decimals, copied onto the journey rather than looked up.
   *
   * A route that is resumed days later must settle into the same asset it started with, even if
   * the RWA table has been edited in the meantime. It also keeps the executor free of the asset
   * table, which is a server-side concern everywhere else in the codebase.
   */
  rwaMint: string;
  rwaDecimals: number;
  /** The Cookie Chain side of the pair: sold in the buy direction, bought in the sell direction. */
  token: { mint: string; symbol: string; decimals: number };
  /** What the user asked for, kept for labelling a route resumed in a fresh session. */
  input: { amount: number; symbol: string; amountRaw?: string };
  /**
   * The plan's legs, in order, exactly as they were priced when the user pressed the button.
   *
   * Stored whole rather than as bare kinds so a route resumed in a fresh session can still draw
   * itself. The amounts here are the original estimate; what each leg actually produced is
   * measured at run time and written into the step's `detail`.
   */
  legs: RouteLeg[];
  /** Index of the next leg to run. Everything below it has confirmed on chain. */
  cursor: number;
  steps: JourneyStep[];
  status: "running" | "done" | "interrupted";

  /** COOK handed to the bridge, as a UI amount. Measured from leg 1, never quoted. */
  bridgeAmount?: number;
  /** Destination COOK balance read before dispatch. Delivery is `current - destBaseline`. */
  destBaseline?: number;
  /** Hyperlane message id, so a stuck transfer can be looked up in the explorer. */
  messageId?: string;

  /** Creator payout only: the launchpad pool whose creator fees are claimed. */
  creatorClaim?: CreatorClaim;
  /** What a leg measured for the next one to sell, in raw units, rather than the amount typed in. */
  sellRaw?: string;

  createdAt: number;
  updatedAt: number;
}

// Spelled the old way on purpose: a cross-chain route that stopped halfway resumes from this key,
// and renaming it along with the product would make the app forget the route it was resuming.
const STORE_KEY = "corwa.journeys.v1";

/** One in-flight route per wallet per pair. */
function keyOf(owner: string, pairSlug: string): string {
  return `${owner}|${pairSlug}`;
}

type Store = Record<string, Journey>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Drop anything written by an older schema rather than trying to migrate a half-signed route.
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === "object" && (v as Journey).v === 1) out[k] = v as Journey;
    }
    return out;
  } catch {
    // Private mode, disabled storage, or corrupt JSON. Losing the resume is bad; throwing here
    // would also lose the trade the user is trying to start.
    return {};
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Nothing useful to do. The run still works in memory for as long as the tab is open.
  }
}

export function loadJourney(owner: string, pairSlug: string): Journey | null {
  return readStore()[keyOf(owner, pairSlug)] ?? null;
}

export function saveJourney(j: Journey): Journey {
  const store = readStore();
  const next = { ...j, updatedAt: Date.now() };
  store[keyOf(j.owner, j.pairSlug)] = next;
  writeStore(store);
  return next;
}

export function clearJourney(owner: string, pairSlug: string): void {
  const store = readStore();
  delete store[keyOf(owner, pairSlug)];
  writeStore(store);
}

export function newJourney(args: {
  direction: JourneyDirection;
  owner: string;
  pairSlug: string;
  ticker: string;
  rwaMint: string;
  rwaDecimals: number;
  token: { mint: string; symbol: string; decimals: number };
  input: { amount: number; symbol: string; amountRaw?: string };
  legs: RouteLeg[];
  creatorClaim?: CreatorClaim;
}): Journey {
  const now = Date.now();
  return {
    v: 1,
    ...args,
    cursor: 0,
    steps: args.legs.map(() => ({ state: "idle" as StepState })),
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Where the money is right now, in plain words.
 *
 * This is the sentence the user actually needs after a failure, and it is decided by `cursor`
 * rather than by which error was thrown: the cursor is the only thing that tracks what confirmed.
 */
export function fundsLocation(j: Journey): string {
  const next = j.legs[j.cursor]?.kind;
  if (next === "creator-claim") {
    return "Nothing has crossed yet. The fees are still on your launchpad pool, or already in your Cookie Chain wallet as COOK if the claim landed.";
  }
  const bridgeLeg = j.legs.findIndex((l) => l.kind === "bridge");
  const bridged = j.bridgeAmount ? `${j.bridgeAmount} COOK` : "your COOK";

  if (j.cursor <= bridgeLeg) {
    return j.direction === "buy"
      ? `Nothing has crossed yet. Your funds are still on Cookie Chain, as ${j.cursor === 0 ? j.token.symbol : "COOK"}.`
      : `Nothing has crossed yet. Your funds are still on Solana, as ${j.cursor === 0 ? `${j.ticker}x` : "COOK"}.`;
  }
  // Past the bridge leg: the transfer has been dispatched, so the funds are in flight or landed.
  return j.direction === "buy"
    ? `The bridge has already taken ${bridged} off Cookie Chain. It is either in flight or waiting in your Solana wallet.`
    : `The bridge has already taken ${bridged} off Solana. It is either in flight or waiting in your Cookie Chain wallet.`;
}

/**
 * True when at least one leg has been signed, so there is something on chain to come back to.
 *
 * A route that failed on its first signature - the usual case being a rejected wallet prompt - has
 * moved no money and is not a stuck route. It is just an attempt that did not start, and dressing
 * it up as one would tell the user their funds are somewhere when they never left.
 */
export function hasTouchedChain(j: Journey): boolean {
  return j.cursor > 0 || j.steps.some((s) => !!s.signature);
}

/** True when a stored route still has work left that the user can pick up. */
export function isResumable(j: Journey | null): j is Journey {
  return !!j && j.status !== "done" && j.cursor < j.legs.length && hasTouchedChain(j);
}
