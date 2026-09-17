import { NextResponse } from "next/server";
import { browserSolanaRpcUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * The Solana RPC calls the browser is allowed to make through Coorwa.
 *
 * Everything the cross-chain routes and the stock payouts need, and nothing else. The heavy scans
 * that make an RPC key expensive, `getProgramAccounts` above all, are not here: Coorwa's own routes
 * do those server side, where they are cached.
 */
const ALLOWED = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getBlockHeight",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "sendTransaction",
  "simulateTransaction",
]);

/** Comfortably above a signed transaction, well below anything worth relaying for somebody else. */
const MAX_BODY_BYTES = 128 * 1024;
/** web3.js batches a handful of reads at most. */
const MAX_BATCH = 10;

interface Call {
  method?: unknown;
}

/**
 * Solana JSON-RPC, relayed with Coorwa's own key.
 *
 * The browser needs a Solana endpoint to read accounts and send the Solana leg of a route, and
 * every usable endpoint is behind a key. Shipping that key in the page would publish it: a domain
 * rule on it only stops other websites, not a script that sets a header. So the key stays a server
 * secret and the browser talks to this instead, which passes on the calls above and nothing else.
 */
export async function POST(req: Request) {
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "that request is too large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "body must be JSON-RPC" }, { status: 400 });
  }

  const calls: Call[] = Array.isArray(payload) ? payload : [payload as Call];
  if (calls.length === 0 || calls.length > MAX_BATCH) {
    return NextResponse.json({ error: `send between 1 and ${MAX_BATCH} calls` }, { status: 400 });
  }
  for (const call of calls) {
    if (typeof call?.method !== "string" || !ALLOWED.has(call.method)) {
      return NextResponse.json(
        { error: `${String(call?.method)} is not relayed by Coorwa` },
        { status: 403 },
      );
    }
  }

  try {
    const upstream = await fetch(browserSolanaRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "the Solana RPC did not answer" },
      { status: 502 },
    );
  }
}
