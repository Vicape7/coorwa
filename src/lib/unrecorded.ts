/**
 * Payments the chain has and Coorwa's ledger does not.
 *
 * Setting a pair and launching a token both happen in two steps: the wallet sends a transaction,
 * then the page reports it to the server, which reads it back from the chain and records it. When
 * the second step fails (the network, a slow RPC, a busy database) the money has already moved, and
 * paying again would pay twice. So the report is kept in localStorage, keyed by the token's mint,
 * and the page offers to send that same report again. The server answers a repeated report of the
 * same transaction the same way it answered the first, so retrying is safe.
 */
import { useMemo, useSyncExternalStore } from "react";

const STORE_KEY = "coorwa-unrecorded";

export type UnrecordedKind = "pair" | "launch";

export interface Unrecorded<B> {
  /** The request body that failed, sent again unchanged. */
  body: B;
  /** Why the last attempt failed, as the server or the network said it. */
  error: string;
}

type Store = Record<string, Unrecorded<unknown>>;

const listeners = new Set<() => void>();

/** Where the store lives when localStorage is blocked, so the retry works until the tab closes. */
let memory = "";

function raw(): string {
  try {
    return window.localStorage.getItem(STORE_KEY) ?? "";
  } catch {
    return memory;
  }
}

function parse(text: string): Store {
  try {
    const parsed = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store) {
  const text = Object.keys(store).length === 0 ? "" : JSON.stringify(store);
  memory = text;
  try {
    if (text) window.localStorage.setItem(STORE_KEY, text);
    else window.localStorage.removeItem(STORE_KEY);
  } catch {
    // Blocked storage: `memory` carries it.
  }
  for (const l of listeners) l();
}

export function saveUnrecorded<B>(kind: UnrecordedKind, mint: string, entry: Unrecorded<B>) {
  write({ ...parse(raw()), [`${kind}:${mint}`]: entry });
}

export function clearUnrecorded(kind: UnrecordedKind, mint: string) {
  const store = parse(raw());
  if (!(`${kind}:${mint}` in store)) return;
  delete store[`${kind}:${mint}`];
  write(store);
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab that records or forgets a payment.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Every waiting report of one kind, by mint. Empty on the server and on the first render. */
export function useUnrecorded<B>(kind: UnrecordedKind): Record<string, Unrecorded<B>> {
  const text = useSyncExternalStore(subscribe, raw, () => "");
  return useMemo(() => {
    const out: Record<string, Unrecorded<B>> = {};
    for (const [k, v] of Object.entries(parse(text))) {
      if (k.startsWith(`${kind}:`)) out[k.slice(kind.length + 1)] = v as Unrecorded<B>;
    }
    return out;
  }, [text, kind]);
}

/**
 * Send a report and say how it went.
 *
 * `final` is true when sending it again cannot change the answer: the server refused it for good
 * with 409 (the token already has a pair, or the payment was used). Anything else, a network error
 * or a 425 for a token whose pool is not ready yet included, is worth another try with the same body.
 */
export async function postRecord(
  url: string,
  body: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; final: boolean; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, final: false, error: "Coorwa could not be reached" };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && !data.error) return { ok: true, data };
  const error = typeof data.error === "string" ? data.error : `the server answered ${res.status}`;
  return { ok: false, final: res.status === 409, error };
}
