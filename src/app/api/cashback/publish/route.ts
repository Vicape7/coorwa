import { NextResponse } from "next/server";
import { z } from "zod";
import { EpochError, publishFromChain } from "@/lib/epochs";

export const dynamic = "force-dynamic";

const Body = z.object({ signature: z.string().min(64).max(128) });

/**
 * Mark a draft published, given the transaction that published it.
 *
 * The signature is the whole argument. Corwa reads it back from the chain, decodes the publish
 * instruction out of it and compares the root with the draft's, so this endpoint needs no key, no
 * token and no session: a caller who has not actually landed a publish transaction signed by the
 * vault's authority has nothing to send here that would work.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    return NextResponse.json({ epoch: await publishFromChain(parsed.data.signature) });
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not confirm the publish" },
      { status },
    );
  }
}
