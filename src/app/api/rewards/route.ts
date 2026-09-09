import { NextResponse } from "next/server";
import { summarise } from "@/lib/cashback";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  try {
    return NextResponse.json(await summarise(wallet));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read cashback" },
      { status: 502 },
    );
  }
}
