import { HTTP_TIMEOUT_MS } from "./config";

export class CoorwaError extends Error {
  // Declared rather than written as constructor parameter properties: the test runner strips types
  // instead of compiling them, and that syntax is the one thing it cannot strip.
  readonly hint?: string;
  readonly status?: number;

  constructor(message: string, hint?: string, status?: number) {
    super(message);
    this.name = "CoorwaError";
    this.hint = hint;
    this.status = status;
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = HTTP_TIMEOUT_MS, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...rest.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j.error ?? j.message ?? detail;
      } catch {
        /* keep the raw body */
      }
      throw new CoorwaError(`HTTP ${res.status}: ${detail}`, undefined, res.status);
    }
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof CoorwaError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new CoorwaError(`request timed out after ${timeoutMs}ms`, url);
    }
    throw new CoorwaError(e instanceof Error ? e.message : String(e), url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A tiny in-process TTL cache. Coorwa fans a lot of reads out to rate-limited public APIs
 * (Jupiter's keyless tier is 0.5 req/s), so every upstream read goes through this.
 */
const cache = new Map<string, { value: unknown; expires: number }>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = load()
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

/** Serve a stale value rather than an error when the upstream is briefly down. */
export async function cachedStale<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  try {
    return await cached(key, ttlMs, load);
  } catch (e) {
    const stale = cache.get(key);
    if (stale) return stale.value as T;
    throw e;
  }
}
