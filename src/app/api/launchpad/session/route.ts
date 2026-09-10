import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchLoginNonce,
  createSession,
  loginMessage,
  verifyLoginSignature,
} from "@/lib/launchpad";

export const dynamic = "force-dynamic";

/** Step 1: hand the browser a server-issued, single-use nonce and the exact message to sign. */
export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet) return NextResponse.json({ error: "wallet is required" }, { status: 400 });

  try {
    const { nonce, ttlSecs } = await fetchLoginNonce();
    const ts = Math.floor(Date.now() / 1000);
    return NextResponse.json({ nonce, ts, ttlSecs, message: loginMessage(wallet, ts, nonce) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not start a session" },
      { status: 502 },
    );
  }
}

const Body = z.object({
  wallet: z.string().min(32).max(44),
  ts: z.number().int(),
  nonce: z.string().min(1),
  /** base58 ed25519 signature over the login message. */
  signature: z.string().min(1),
});

/** How long a nonce stays good upstream. Beyond it the message is stale, not wrong. */
const NONCE_TTL_SECS = 300;

/** Step 2: exchange the wallet's signature for a session token. Nothing is signed on-chain. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Both checks exist because the launchpad answers every one of these with the same flat
  // `401 Invalid signature`, and a user cannot act on that. Catching them here costs one upstream
  // call and turns the failure into something specific enough to fix.
  const age = Math.floor(Date.now() / 1000) - parsed.data.ts;
  if (age > NONCE_TTL_SECS) {
    return NextResponse.json(
      {
        error: "the login message went stale before it was signed",
        hint: `it is good for ${NONCE_TTL_SECS / 60} minutes and this one was ${Math.round(age / 60)} minutes old, so start the launch again`,
      },
      { status: 400 },
    );
  }
  if (!verifyLoginSignature(parsed.data)) {
    return NextResponse.json(
      {
        error: "that signature does not match the login message",
        hint: "the wallet signed with a different account than the one it is connected as, or changed the message before signing it. Reconnect the wallet, check the account it shows, and retry",
      },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await createSession(parsed.data));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "login rejected" },
      { status: 502 },
    );
  }
}
