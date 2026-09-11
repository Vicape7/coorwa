import { NextResponse } from "next/server";
import { z } from "zod";
import { buildCreatePoolTx, uploadImage, fetchConfig } from "@/lib/launchpad";
import { COOK_DECIMALS } from "@/lib/config";
import { uiToRaw } from "@/lib/format";
import { CoorwaError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  creator: z.string().min(32).max(44),
  /** Session token from /api/launchpad/session - the launch path is signature-gated. */
  session: z.string().min(1),
  name: z.string().min(1).max(32),
  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9]+$/, "symbol must be letters and digits"),
  description: z.string().max(500).optional(),
  /** Data URL or bare base64. Pinned to IPFS by the launchpad; metadata is immutable afterwards. */
  imageBase64: z.string().optional(),
  imageContentType: z.string().optional(),
  imageUrl: z.string().url().optional(),
  /** Hours the curve stays open. */
  durationHours: z.number().min(1).max(720).default(72),
  expiryMode: z.enum(["dead", "fair", "jackpot", "survivor"]).default("fair"),
  /** COOK the creator buys on their own curve at launch. */
  devBuyCook: z.number().min(0).default(0),
});

/**
 * Build a launch transaction.
 *
 * Nothing is signed here: the launchpad returns a partially-signed transaction (it holds the mint
 * keypair it leased) and the creator's wallet adds the last signature in the browser.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const b = parsed.data;

  try {
    const config = await fetchConfig();
    if (config.paused) {
      return NextResponse.json(
        { error: "the launchpad is paused", hint: "try again once it reopens" },
        { status: 409 },
      );
    }
    if (config.momoReady === 0) {
      return NextResponse.json(
        {
          error: "no mint addresses in reserve",
          hint: "the launchpad grinds `momo`-suffixed keypairs ahead of time and has run out; retry shortly",
        },
        { status: 409 },
      );
    }

    let image = b.imageUrl;
    if (!image && b.imageBase64) {
      const raw = b.imageBase64.includes(",") ? b.imageBase64.split(",")[1] : b.imageBase64;
      image = await uploadImage(raw, b.imageContentType ?? "image/png");
    }

    const now = Math.floor(Date.now() / 1000);
    const built = await buildCreatePoolTx({
      creator: b.creator,
      session: b.session,
      params: {
        name: b.name,
        symbol: b.symbol.toUpperCase(),
        // Start immediately; the programme treats a past launch_ts as "open now".
        launch_ts: now,
        duration_secs: Math.round(b.durationHours * 3600),
        expiry_mode: b.expiryMode,
        migratable: true,
        anti_snipe: true,
        min_buy: "0",
        max_buy_per_wallet: "0",
        max_payment_raise: "0",
      },
      metadata: {
        name: b.name,
        symbol: b.symbol.toUpperCase(),
        description: b.description,
        image,
      },
      devBuyCook: b.devBuyCook > 0 ? uiToRaw(b.devBuyCook, COOK_DECIMALS) : undefined,
    });

    return NextResponse.json(built);
  } catch (e) {
    const err = e instanceof CoorwaError ? e : null;
    const unauthorized = /401|session/i.test(e instanceof Error ? e.message : "");
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "launch build failed",
        hint: unauthorized
          ? "the launchpad session expired - sign in again and retry"
          : err?.hint,
      },
      { status: unauthorized ? 401 : 502 },
    );
  }
}
