import { NextResponse } from "next/server";
import { fetchCurvePosition, fetchPools } from "@/lib/launchpad";
import { ADDRESS_RE, CURVE_TOKEN_DECIMALS } from "@/lib/config";
import { rawToUi } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * What a wallet still has to claim from the curve a token graduated from.
 *
 * A graduated curve does not hand out its tokens by itself: every holder's shares wait on the
 * programme until that holder claims them. This finds the curve behind a token and reads the
 * wallet's position there. A public read of a public position, so it takes no signature.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mint = url.searchParams.get("mint")?.trim();
  const wallet = url.searchParams.get("wallet")?.trim();
  if (!mint || !wallet || !ADDRESS_RE.test(mint) || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json(
      { error: "mint and wallet are both required, as addresses" },
      { status: 400 },
    );
  }

  try {
    const pool = (await fetchPools("graduated")).find((p) => p.tokenMint === mint);
    if (!pool) return NextResponse.json({ pool: null, tokens: 0, claimable: false });

    const position = await fetchCurvePosition(pool.pubkey, wallet);
    const shares = position?.shares ?? "0";
    const claimable = !!position && !position.graduatedTokensClaimed && BigInt(shares) > 0n;
    return NextResponse.json({
      pool: pool.pubkey,
      tokens: claimable ? rawToUi(shares, CURVE_TOKEN_DECIMALS) : 0,
      claimable,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read the curve", claimable: false },
      { status: 502 },
    );
  }
}
