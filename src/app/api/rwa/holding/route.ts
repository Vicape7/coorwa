import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { readHolding, readMultiplier } from "@/lib/rwa-holding";
import { rwaByTicker } from "@/lib/rwa";
import { serverSolanaRpcUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

const Query = z.object({
  ticker: z.string().min(1).max(10),
  /** Optional: without it, only the mint's multiplier comes back, which is enough to size a sale. */
  owner: z.string().min(32).max(44).optional(),
});

/**
 * An xStock position, read server-side.
 *
 * This exists because Solana's public RPC answers a server and returns 403 to anything carrying a
 * browser origin. Reading the mint from the panel would therefore fail quietly and fall back to a
 * multiplier of 1, which sizes a sale wrong by exactly the rebase - enough to fail a swap for
 * insufficient balance on a balance the user can see is large enough.
 *
 * A multiplier that cannot be read is answered as an error rather than as 1, for the same reason.
 * The holding comes back only when an owner is given, so the sell panel can price a size before a
 * wallet is connected.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid query", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const asset = rwaByTicker(parsed.data.ticker);
  if (!asset) {
    return NextResponse.json({ error: `unknown RWA: ${parsed.data.ticker}` }, { status: 404 });
  }

  const conn = new Connection(serverSolanaRpcUrl(), "confirmed");

  try {
    const [multiplier, holding] = await Promise.all([
      readMultiplier(conn, asset.mint),
      parsed.data.owner
        ? readHolding(conn, new PublicKey(parsed.data.owner), asset.mint).catch(() => null)
        : Promise.resolve(null),
    ]);

    // Answering with a guessed multiplier would be worse than answering with nothing: it is what a
    // caller sizes a sale by, and a rebase-sized error fails a swap on a balance that looks big
    // enough.
    if (multiplier === null) {
      return NextResponse.json(
        { error: `could not read the multiplier on ${parsed.data.ticker}` },
        { status: 502 },
      );
    }

    return NextResponse.json({ mint: asset.mint, decimals: asset.decimals, multiplier, holding });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read the position" },
      { status: 502 },
    );
  }
}
