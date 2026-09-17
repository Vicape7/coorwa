import { NextResponse } from "next/server";
import { fetchPools, graduationProgress, type PoolStatus } from "@/lib/launchpad";
import { fetchCookPriceUsd } from "@/lib/cookiescan";
import { logosByMint } from "@/lib/token-logos";
import { benchmarks } from "@/lib/launches";
import { listedByMint } from "@/lib/listings";

export const dynamic = "force-dynamic";

const VALID: (PoolStatus | "all")[] = ["all", "upcoming", "live", "ended", "graduated", "expired"];

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("status") ?? "all";
  const status = (VALID as string[]).includes(raw) ? (raw as PoolStatus | "all") : "all";

  try {
    // Curves are priced in COOK, and every USD figure the panel shows hangs off this one rate. It
    // rides along here so the trade surface needs a single poll rather than two.
    const [pools, cookPriceUsd] = await Promise.all([fetchPools(status), fetchCookPriceUsd()]);
    // The pair a token pays out in, whether it was picked at launch here or bought afterwards.
    const [logos, pinned, listed] = await Promise.all([
      logosByMint(pools.map((p) => ({ mint: p.tokenMint, uri: p.uri }))),
      benchmarks().catch(() => new Map<string, string>()),
      listedByMint().catch(() => new Map<string, string>()),
    ]);
    const withProgress = pools
      .map((p) => ({
        ...p,
        logo: logos.get(p.tokenMint) ?? null,
        ticker: pinned.get(p.tokenMint) ?? listed.get(p.tokenMint) ?? null,
        progress: graduationProgress(p),
      }))
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
