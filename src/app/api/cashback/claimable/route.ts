import { NextResponse } from "next/server";
import { EpochError, claimableFor } from "@/lib/epochs";

export const dynamic = "force-dynamic";

/**
 * What this wallet can claim from the vault right now, with the proof for each line.
 *
 * Read-only and public. The proofs are not secrets: a proof only opens the leaf that names the
 * wallet it belongs to, so handing one out to a stranger gives them nothing.
 */
export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  try {
    return NextResponse.json(await claimableFor(wallet));
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read the vault" },
      { status },
    );
  }
}
