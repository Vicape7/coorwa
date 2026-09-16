import { NextResponse } from "next/server";
import { tokenRewards } from "@/lib/cashback";

export const dynamic = "force-dynamic";

/** One token's holder rewards: what is waiting, what has been paid, and when the next run is. */
export async function GET(req: Request) {
  const mint = new URL(req.url).searchParams.get("mint")?.trim();
  if (!mint) return NextResponse.json({ error: "mint is required" }, { status: 400 });
  try {
    return NextResponse.json(await tokenRewards(mint));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read the token's rewards" },
      { status: 502 },
    );
  }
}
