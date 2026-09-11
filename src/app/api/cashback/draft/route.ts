import { NextResponse } from "next/server";
import { z } from "zod";
import { EpochError, buildDraft, checkTree, toCook } from "@/lib/epochs";

export const dynamic = "force-dynamic";

const Body = z.object({
  /**
   * Replace a draft that is already waiting. Off by default, because a draft the authority has
   * already signed against would be orphaned by a rebuild, and the publish would then be refused.
   */
  rebuild: z.boolean().default(false),
});

/** How many lines to show back. The tree can hold millions; a person reviewing it cannot. */
const PREVIEW = 25;

/**
 * Work out the next epoch and freeze it as a draft.
 *
 * Deliberately unauthenticated. A draft moves no money and names nobody who is not already owed
 * something by arithmetic anyone can redo from the public fills, and the call is idempotent, so
 * the worst a stranger achieves is making Coorwa compute the same answer twice. The step that does
 * move money is the publish transaction, and only the vault's authority can sign that - the
 * program checks, not this endpoint.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const draft = await buildDraft({ rebuild: parsed.data.rebuild });

    // A tree that cannot open its own leaves would only be discovered by the first claimant, on
    // chain, after the money was already reserved. It costs nothing to find out here instead.
    checkTree(BigInt(draft.epoch.index), draft.lines);

    return NextResponse.json({
      epoch: draft.epoch,
      reused: draft.reused,
      freeCook: draft.freeCook,
      shortfallCook: draft.shortfallCook,
      lines: draft.lines.slice(0, PREVIEW).map((l) => ({
        wallet: l.wallet,
        amountCook: toCook(l.amountRaw),
        amountUsd: l.amountUsd,
        traderUsd: l.traderUsd,
        creatorUsd: l.creatorUsd,
      })),
      truncated: Math.max(0, draft.lines.length - PREVIEW),
    });
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not build the epoch" },
      { status },
    );
  }
}
