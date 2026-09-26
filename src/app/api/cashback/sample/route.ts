import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { HolderSampleError, recordHolderSample } from "@/lib/holder-samples";
import { runPayoutStep } from "@/lib/payout-cycle";
import { runTaxSweep } from "@/lib/tax-sweep";

export const dynamic = "force-dynamic";

/**
 * Maybe take a holder sample, advance the daily payout run by one step, and sweep the transfer tax
 * of Coorwa's own tokens when the run has nothing to do. Called every few
 * minutes by the scheduler (cron-job.org, or the sampler Worker in `workers/`).
 *
 * Guarded by a shared secret rather than left open, because whoever can choose when a sample is
 * taken can hold a token only across that moment. The secret keeps the
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
    const status = e instanceof HolderSampleError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not take a holder sample" },
      { status },
    );
  }

  // After the sample, so a run that becomes due now includes it. A failed step is reported in the
  // body rather than as an error status: the sample succeeded, and the next call retries the step.
  const payout = await runPayoutStep().catch((e: unknown) => ({
    action: "error",
    detail: e instanceof Error ? e.message : String(e),
  }));

  // The tax sweep only gets a call the payout run did not need, so the two never share one request
  // and neither is cut short by the scheduler's timeout. A pass is hourly and a run is daily, so the
  // sweep is never kept waiting for long.
  const tax =
    payout.action === "idle"
      ? await runTaxSweep().catch((e: unknown) => ({
          action: "error",
          detail: e instanceof Error ? e.message : String(e),
        }))
      : { action: "skipped", detail: "the payout run had this call" };
  return NextResponse.json({ ...sample, payout, tax });
}
