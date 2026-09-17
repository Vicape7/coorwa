import { NextResponse } from "next/server";
import { fetchConfig, fetchPosition } from "@/lib/launchpad";
import { ADDRESS_RE } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * What a wallet still holds on one curve.
 *
 * Curve shares are not SPL tokens - the programme tracks them - so nothing in a wallet shows them
 * and the sell side of the panel would otherwise have nothing to offer. This is a read, and a read
 * of a public position at that, so it takes no signature.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pool = url.searchParams.get("pool")?.trim();
  const wallet = url.searchParams.get("wallet")?.trim();

  if (!pool || !wallet || !ADDRESS_RE.test(pool) || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json(
      { error: "pool and wallet are both required, as addresses" },
      { status: 400 },
    );
  }

  try {
    const { defaultTokenDecimals } = await fetchConfig();
    const position = await fetchPosition(pool, wallet, defaultTokenDecimals);
    return NextResponse.json({ ...position, decimals: defaultTokenDecimals });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "could not read the position",
        shares: "0",
        source: "none",
      },
      { status: 502 },
    );
  }
}
