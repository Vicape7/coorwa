import { NextResponse } from "next/server";
import { z } from "zod";
import { recordLaunch, launchesByCreator } from "@/lib/launches";
import { proveTransaction, isProven } from "@/lib/onchain";
import { rwaByTicker } from "@/lib/rwa";

export const dynamic = "force-dynamic";

const Body = z.object({
  signature: z.string().min(64).max(128),
  mint: z.string().min(32).max(44),
  pool: z.string().min(32).max(44),
  creator: z.string().min(32).max(44),
  /** The RWA the creator picked. Checked against the assets Corwa actually prices. */
  ticker: z.string().min(1).max(12),
  symbol: z.string().max(32).optional(),
  name: z.string().max(64).optional(),
});

/**
 * Record the benchmark a creator chose for the token they just launched.
 *
 * The benchmark decides what pair the token trades as for the rest of its life, so it is not taken
 * on trust: the launch transaction is read back from the chain, has to have been signed by the
 * creator, and has to name both the mint and the pool being claimed. Without that a wallet could
 * pin somebody else's token to whatever asset flattered it.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const b = parsed.data;

  const asset = rwaByTicker(b.ticker);
  if (!asset) {
    return NextResponse.json(
      { error: `${b.ticker} is not an asset Corwa prices`, recorded: false },
      { status: 400 },
    );
  }

  try {
    const proof = await proveTransaction({ signature: b.signature, wallet: b.creator });
    if (!isProven(proof)) {
      return NextResponse.json({ error: proof.error, recorded: false }, { status: proof.status });
    }
    if (!proof.accounts.has(b.mint) || !proof.accounts.has(b.pool)) {
      return NextResponse.json(
        {
          error: "that transaction did not create this token",
          hint: "the mint and pool being claimed have to appear in the launch transaction itself",
          recorded: false,
        },
        { status: 403 },
      );
    }

    const res = await recordLaunch({ ...b, ticker: asset.ticker });
    return NextResponse.json({
      ...res,
      ticker: asset.ticker,
      note: res.recorded
        ? undefined
        : "benchmarks are not stored on this deployment (no DATABASE_URL), so the token stays quotable against every asset",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not record the launch", recorded: false },
      { status: 502 },
    );
  }
}

/** What one wallet has launched here. Backs the creator's own panel. */
export async function GET(req: Request) {
  const creator = new URL(req.url).searchParams.get("creator")?.trim();
  if (!creator) return NextResponse.json({ error: "creator is required" }, { status: 400 });

  try {
    return NextResponse.json({ launches: await launchesByCreator(creator) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load launches", launches: [] },
      { status: 502 },
    );
  }
}
