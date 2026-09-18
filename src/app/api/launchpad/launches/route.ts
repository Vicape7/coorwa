import { NextResponse } from "next/server";
import { z } from "zod";
import { recordLaunch, launchesByCreator } from "@/lib/launches";
import { createsLaunchpadToken, isProven, proveTransaction } from "@/lib/onchain";
import { ADDRESS_RE } from "@/lib/config";
import { rwaByTicker } from "@/lib/rwa";
import { listedFor } from "@/lib/listings";

export const dynamic = "force-dynamic";

const Body = z.object({
  signature: z.string().min(64).max(128),
  mint: z.string().regex(ADDRESS_RE, "not an address"),
  pool: z.string().regex(ADDRESS_RE, "not an address"),
  creator: z.string().regex(ADDRESS_RE, "not an address"),
  /** The RWA the creator picked. Checked against the assets Coorwa actually prices. */
  ticker: z.string().min(1).max(12),
  symbol: z.string().max(32).optional(),
  name: z.string().max(64).optional(),
});

/**
 * Record the benchmark a creator chose for the token they just launched.
 *
 * The benchmark decides what pair the token trades as for the rest of its life, so it is not taken
 * on trust: the launch transaction is read back from the chain, has to have been signed by the
 * creator, and has to be the launch itself (see `createsToken`). Without that a wallet could pin
 * somebody else's token to whatever asset flattered it, and be paid its creator's share.
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
      { error: `${b.ticker} is not an asset Coorwa prices`, recorded: false },
      { status: 400 },
    );
  }

  try {
    const proof = await proveTransaction({ signature: b.signature, wallet: b.creator });
    if (!isProven(proof)) {
      return NextResponse.json({ error: proof.error, recorded: false }, { status: proof.status });
    }
    if (!createsLaunchpadToken(proof, b.mint, b.pool)) {
      return NextResponse.json(
        {
          error: "that transaction did not create this token",
          hint: "the launch transaction itself has to create the mint and its pool on the launchpad, and a trade on the token is not that transaction",
          recorded: false,
        },
        { status: 403 },
      );
    }

    // A pair is set once. A creator who already bought one for this token keeps it: holders bought
    // the token expecting to be paid in that stock, and a launch recorded later must not replace it.
    const listed = await listedFor(b.mint);
    if (listed) {
      return NextResponse.json(
        { error: `this token is already paired with ${listed}`, recorded: false },
        { status: 409 },
      );
    }

    const res = await recordLaunch({ ...b, ticker: asset.ticker });
    if (res.existing) {
      // The same launch reported twice, a retry, is answered as recorded. A different pick is not.
      return res.existing === asset.ticker
        ? NextResponse.json({ recorded: true, ticker: asset.ticker })
        : NextResponse.json(
            { error: `this token is already paired with ${res.existing}`, recorded: false },
            { status: 409 },
          );
    }
    return NextResponse.json({
      ...res,
      ticker: asset.ticker,
      note: res.recorded
        ? undefined
        : "pairs are not stored on this deployment (no DATABASE_URL), so the token has no pair here",
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
