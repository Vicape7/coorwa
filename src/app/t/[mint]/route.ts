import { NextResponse } from "next/server";
import { isAddress, metadataKey, metadataStore } from "@/lib/launch-metadata";

export const dynamic = "force-dynamic";

/**
 * The uri a Coorwa-launched mint carries.
 *
 * Served from the app rather than from a bucket of its own so the link is short enough for the
 * program's 200-byte limit and stays on the domain the token already belongs to.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  if (!isAddress(mint)) {
    return NextResponse.json({ error: "not a mint address" }, { status: 400 });
  }

  const store = metadataStore();
  if (!store) {
    return NextResponse.json({ error: "metadata storage is not configured" }, { status: 503 });
  }

  const object = await store.get(metadataKey(mint));
  if (!object) {
    return NextResponse.json({ error: `no metadata for ${mint}` }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(object.body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A document can still be rewritten until its launch lands, so the edge holds it for an hour
      // rather than forever, and may serve a stale copy while it fetches the next one.
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
    },
  });
}
