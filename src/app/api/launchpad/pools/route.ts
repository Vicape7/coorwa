import { NextResponse } from "next/server";
import { fetchPools, graduationProgress, type PoolStatus } from "@/lib/launchpad";
import { fetchCookPriceUsd } from "@/lib/cookiescan";

export const dynamic = "force-dynamic";

const VALID: (PoolStatus | "all")[] = ["all", "upcoming", "live", "ended", "graduated", "expired"];

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("status") ?? "all";
  const status = (VALID as string[]).includes(raw) ? (raw as PoolStatus | "all") : "all";

  try {
    // Curves are priced in COOK, and every USD figure the panel shows hangs off this one rate. It
    // rides along here so the trade surface needs a single poll rather than two.
    const [pools, cookPriceUsd] = await Promise.all([fetchPools(status), fetchCookPriceUsd()]);
    const withProgress = pools
      .map((p) => ({ ...p, progress: graduationProgress(p) }))
      .sort((a, b) => b.progress - a.progress);
    return NextResponse.json({
      pools: withProgress,
      count: withProgress.length,
      cookPriceUsd,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load pools", pools: [] },
      { status: 502 },
    );
  }
}
