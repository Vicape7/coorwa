import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { EpochError, recordHolderSample } from "@/lib/epochs";

export const dynamic = "force-dynamic";

/**
 * Maybe take a holder sample. Called every few minutes by the sampler Worker in `workers/`.
 *
 * Guarded by a shared secret rather than left open, for the same reason the draft is: whoever can
 * choose when a sample is taken can hold a token only across that moment. The secret keeps the
 * choice with the schedule, and the dice inside `recordHolderSample` keep it away from the schedule
 * too.
 */
export async function POST(req: Request) {
  const secret = process.env.HOLDER_SAMPLE_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "holder sampling is not configured here (no HOLDER_SAMPLE_SECRET)" },
      { status: 503 },
    );
  }

  const given = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  try {
    return NextResponse.json(await recordHolderSample());
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not take a holder sample" },
      { status },
    );
  }
}
