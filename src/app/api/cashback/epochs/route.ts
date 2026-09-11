import { NextResponse } from "next/server";
import { EpochError, overview } from "@/lib/epochs";

export const dynamic = "force-dynamic";

/**
 * Every epoch Coorwa knows about, each one crossed with what the chain says about it.
 *
 * Public, because the whole point of publishing a root is that anybody can audit it: the totals
 * here can be checked against the epoch accounts without asking Coorwa for anything.
 */
export async function GET() {
  try {
    return NextResponse.json(await overview());
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read the epochs" },
      { status },
    );
  }
}
