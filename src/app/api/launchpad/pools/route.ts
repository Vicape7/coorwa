import { NextResponse } from "next/server";
import { fetchPools, graduationProgress, type PoolStatus } from "@/lib/launchpad";

export const dynamic = "force-dynamic";

const VALID: (PoolStatus | "all")[] = ["all", "upcoming", "live", "ended", "graduated", "expired"];

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("status") ?? "all";
  const status = (VALID as string[]).includes(raw) ? (raw as PoolStatus | "all") : "all";

  try {
    const pools = await fetchPools(status);
    const withProgress = pools
      .map((p) => ({ ...p, progress: graduationProgress(p) }))
      .sort((a, b) => b.progress - a.progress);
    return NextResponse.json({ pools: withProgress, count: withProgress.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load pools", pools: [] },
      { status: 502 },
    );
  }
}
