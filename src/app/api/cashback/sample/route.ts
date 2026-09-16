import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { EpochError, recordHolderSample } from "@/lib/epochs";
import { runAutoEpoch } from "@/lib/auto-epoch";

export const dynamic = "force-dynamic";

/**
 * Maybe take a holder sample, then publish the open epoch if it has run for a day. Called every few
 * minutes by the scheduler (cron-job.org, or the sampler Worker in `workers/`).
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

  let sample;
  try {
    sample = await recordHolderSample();
  } catch (e) {
    const status = e instanceof EpochError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not take a holder sample" },
      { status },
    );
  }

  // After the sample, so an epoch that becomes due now includes it. A failed publish is reported
  // in the body rather than as an error status: the sample itself succeeded, and the scheduler
  // retries the epoch on its next call anyway.
  const epoch = await runAutoEpoch().catch((e: unknown) => ({
    published: false,
    reason: "error",
    error: e instanceof Error ? e.message : String(e),
  }));
  return NextResponse.json({ ...sample, epoch });
}
