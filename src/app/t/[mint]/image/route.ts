import { NextResponse } from "next/server";
import { isAddress, imageKey } from "@/lib/launch-metadata";
import { metadataStore } from "@/lib/launch-store";

export const dynamic = "force-dynamic";

/** The picture the document above names. Whoever reads the metadata reads this next. */
export async function GET(_req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  if (!isAddress(mint)) {
    return NextResponse.json({ error: "not a mint address" }, { status: 400 });
  }

  const store = metadataStore();
  if (!store) {
    return NextResponse.json({ error: "metadata storage is not configured" }, { status: 503 });
  }

  const object = await store.get(imageKey(mint));
  if (!object) {
    return NextResponse.json({ error: `no image for ${mint}` }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(object.body), {
    headers: {
      "content-type": object.contentType,
      // The image is written once and never replaced under the same key, so it can be cached hard.
      "cache-control": "public, max-age=86400, s-maxage=31536000, immutable",
      "access-control-allow-origin": "*",
      // The store only ever holds bytes that sniffed as an image, and this says so out loud.
      "x-content-type-options": "nosniff",
    },
  });
}
