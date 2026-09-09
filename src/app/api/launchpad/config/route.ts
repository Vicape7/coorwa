import { NextResponse } from "next/server";
import { fetchConfig, feeBreakdown } from "@/lib/launchpad";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await fetchConfig();
    return NextResponse.json({ config, fees: feeBreakdown(config) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "launchpad unavailable" },
      { status: 502 },
    );
  }
}
