/**
 * Per-address limits on the two routes that cost Coorwa something every time they are called: the
 * Solana relay spends a paid RPC key, and the metadata route writes to R2.
 *
 * Counted by Cloudflare's rate limiting binding (`ratelimits` in wrangler.jsonc), once per location
 * and loosely, which is enough to stop a script and never noticed by a person. The key is the
 * caller's IP. Cloudflare advises against that because many people can share one, so the limits are
 * set far above what the site itself sends.
 *
 * Server only. Everything fails open: without the binding (`next dev`, tests) or when the limiter
 * itself errors, the request goes through.
 */
import { NextResponse } from "next/server";

type LimiterName = "RPC_LIMITER" | "METADATA_LIMITER";

interface RateLimiter {
  limit(args: { key: string }): Promise<{ success: boolean }>;
}

/** Read through the symbol for the same reason `src/lib/db/index.ts` does. */
function limiter(name: LimiterName): RateLimiter | undefined {
  const cf = (globalThis as Record<symbol, { env?: Partial<Record<LimiterName, RateLimiter>> } | undefined>)[
    Symbol.for("__cloudflare-context__")
  ];
  return cf?.env?.[name];
}

/** Whether this caller is still within the limit named. */
export async function withinLimit(name: LimiterName, req: Request): Promise<boolean> {
  const binding = limiter(name);
  const ip = req.headers.get("cf-connecting-ip");
  if (!binding || !ip) return true;
  try {
    return (await binding.limit({ key: ip })).success;
  } catch {
    return true;
  }
}

/** The answer for a caller over the limit. Both limiters count in windows of a minute or less. */
export function tooManyRequests(): NextResponse {
  return NextResponse.json(
    { error: "too many requests from this address", hint: "wait a minute and try again" },
    { status: 429, headers: { "retry-after": "60" } },
  );
}
