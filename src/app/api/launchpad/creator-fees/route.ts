import { NextResponse } from "next/server";
import { fetchPendingCreatorFees } from "@/lib/launchpad";
import { ADDRESS_RE } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * What a curve owes its creator right now, in COOK.
 *
 * MomoSwap pays the creator 35% of its 1% trade fee, and it accumulates on the pool until claimed.
 * This is a public read of a public number: it takes no signature, and knowing the figure is not
 * the same as being able to claim it, which the programme gates on the creator's own key.
 */
export async function GET(req: Request) {
  const pool = new URL(req.url).searchParams.get("pool")?.trim();
  if (!pool || !ADDRESS_RE.test(pool)) {
    return NextResponse.json({ error: "pool must be an address" }, { status: 400 });
  }

  try {
    return NextResponse.json({ pool, pendingCook: await fetchPendingCreatorFees(pool) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read creator fees", pendingCook: 0 },
      { status: 502 },
    );
  }
}
