import { NextResponse } from "next/server";
import { COOKIE_RPC_URL } from "@/lib/config";
import { fetchJson, cachedStale } from "@/lib/http";
import { fetchCookPriceUsd } from "@/lib/cookiescan";
import { fetchCookOnSolana } from "@/lib/jupiter";

export const dynamic = "force-dynamic";

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const body = await fetchJson<{ result: T }>(COOKIE_RPC_URL, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return body.result;
}

/** Chain vitals plus the one number that governs cross-chain capacity: COOK depth on Solana. */
export async function GET() {
  try {
    const data = await cachedStale("chain:health", 5_000, async () => {
      const [health, version, epoch, cookUsd, cookSol] = await Promise.all([
        rpc<string>("getHealth").catch(() => "unknown"),
        rpc<{ "solana-core": string }>("getVersion").catch(() => null),
        rpc<{
          absoluteSlot: number;
          blockHeight: number;
          epoch: number;
          slotIndex: number;
          slotsInEpoch: number;
          transactionCount: number;
        }>("getEpochInfo"),
        fetchCookPriceUsd().catch(() => null),
        fetchCookOnSolana().catch(() => null),
      ]);

      return {
        healthy: health === "ok",
        version: version?.["solana-core"] ?? null,
        slot: epoch.absoluteSlot,
        blockHeight: epoch.blockHeight,
        epoch: epoch.epoch,
        epochProgress: epoch.slotsInEpoch ? epoch.slotIndex / epoch.slotsInEpoch : null,
        transactionCount: epoch.transactionCount,
        cookPriceUsd: cookUsd,
        bridge: {
          cookLiquidityOnSolanaUsd: cookSol?.liquidity ?? null,
          cookHoldersOnSolana: cookSol?.holderCount ?? null,
        },
      };
    });

    return NextResponse.json(data, {
      headers: { "cache-control": "public, s-maxage=5, stale-while-revalidate=30" },
    });
  } catch (e) {
    return NextResponse.json(
      { healthy: false, error: e instanceof Error ? e.message : "rpc unreachable" },
      { status: 502 },
    );
  }
}
