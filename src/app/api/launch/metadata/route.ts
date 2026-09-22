import { NextResponse } from "next/server";
import { z } from "zod";
import { Connection, PublicKey } from "@solana/web3.js";
import { COOKIE_RPC_URL } from "@/lib/config";
import { rwaByTicker } from "@/lib/rwa";
import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MESSAGE_TTL_SECS,
  imageKey,
  imageUri,
  isAddress,
  isImageType,
  metadataDocument,
  metadataKey,
  metadataStore,
  metadataUri,
  sniffImageType,
  verifyMetadataSignature,
} from "@/lib/launch-metadata";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Base64 for the 2 MB the form refuses to go over, with room for the encoding. */
const MAX_IMAGE_BASE64 = 3_000_000;

const Body = z.object({
  creator: z.string().min(32).max(44),
  /** The mint the launch transaction will create. The creator signs for this address. */
  mint: z.string().min(32).max(44),
  ts: z.number().int(),
  /** base58 ed25519 signature over the message in `src/lib/launch-metadata.ts`. */
  signature: z.string().min(1),
  name: z.string().min(1).max(32),
  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9]+$/, "symbol must be letters and digits"),
  description: z.string().max(500).optional(),
  /** Data url or bare base64, stored by Coorwa and served from /t/<mint>/image. */
  imageBase64: z.string().max(MAX_IMAGE_BASE64).optional(),
  imageContentType: z.string().max(40).optional(),
  /** An image the creator already hosts, used as it is instead of storing one. */
  imageUrl: z.string().url().max(200).startsWith("https://").optional(),
  /** Ticker of the stock the token is paired with, when the creator has picked one. */
  pair: z.string().max(10).optional(),
});

function bad(error: string, hint?: string, status = 400) {
  return NextResponse.json({ error, hint }, { status });
}

/** Whether the mint already exists, which is what makes its metadata final. */
async function mintExists(mint: string): Promise<boolean> {
  const connection = new Connection(COOKIE_RPC_URL, "confirmed");
  return (await connection.getAccountInfo(new PublicKey(mint))) !== null;
}

/**
 * Store the metadata for a launch that is about to happen.
 *
 * Called before the launch transaction is built, because the uri this returns goes into the mint
 * itself and cannot be added afterwards. Nothing here touches the chain apart from one read: the
 * creator signs a message naming their mint, and that signature is the whole authorisation.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const b = parsed.data;

  if (!isAddress(b.creator) || !isAddress(b.mint)) {
    return bad("creator and mint must be addresses");
  }

  const age = Math.floor(Date.now() / 1000) - b.ts;
  if (age > MESSAGE_TTL_SECS || age < -MESSAGE_TTL_SECS) {
    return bad(
      "the signed message is not from now",
      `it is good for ${MESSAGE_TTL_SECS / 60} minutes either way, so sign again and retry`,
    );
  }
  if (!verifyMetadataSignature({ wallet: b.creator, mint: b.mint, ts: b.ts, signature: b.signature })) {
    return bad(
      "that signature does not match the message",
      "the wallet signed with a different account than the one it is connected as, or for a different mint. Reconnect the wallet and retry",
    );
  }
  if (b.pair && !rwaByTicker(b.pair)) {
    return bad(`${b.pair} is not a stock Coorwa pairs with`);
  }

  const store = metadataStore();
  if (!store) {
    return bad(
      "metadata storage is not configured",
      "the METADATA bucket is not bound to this deployment",
      503,
    );
  }

  // Metadata is rewritable only while the launch has not landed. Once the mint exists, what the uri
  // returns is part of the token, and a creator changing it later would be changing the token.
  const existing = await store.head(metadataKey(b.mint));
  if (existing) {
    if (existing.creator && existing.creator !== b.creator) {
      return bad("metadata for this mint was written by another wallet", undefined, 409);
    }
    let live: boolean;
    try {
      live = await mintExists(b.mint);
    } catch {
      return bad(
        "could not check whether that mint is already on chain",
        "Cookie Chain did not answer, and overwriting metadata for a token that is already live is not allowed. Try again shortly",
        502,
      );
    }
    if (live) {
      return bad(
        "that token is already on chain, so its metadata is fixed",
        "launch a new token if you need different metadata",
        409,
      );
    }
  }

  let image = b.imageUrl ?? null;
  let imageType: keyof typeof IMAGE_TYPES | undefined;

  if (!image && b.imageBase64) {
    const raw = b.imageBase64.includes(",") ? b.imageBase64.split(",")[1] : b.imageBase64;
    const bytes = new Uint8Array(Buffer.from(raw, "base64"));
    if (bytes.length === 0) return bad("the image did not decode");
    if (bytes.length > MAX_IMAGE_BYTES) {
      return bad(`the image is over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
    }
    const sniffed = sniffImageType(bytes);
    if (!sniffed) {
      return bad(
        "that file is not a PNG, JPEG, GIF or WebP",
        "Coorwa serves it from its own domain, so it stores images and nothing else",
      );
    }
    if (b.imageContentType && isImageType(b.imageContentType) && b.imageContentType !== sniffed) {
      return bad(`the file is a ${sniffed}, not a ${b.imageContentType}`);
    }
    await store.put(imageKey(b.mint), bytes, sniffed, b.creator);
    image = imageUri(b.mint);
    imageType = sniffed;
  }

  const document = metadataDocument({
    mint: b.mint,
    name: b.name,
    symbol: b.symbol,
    description: b.description,
    image,
    imageType,
    pair: b.pair,
  });

  await store.put(
    metadataKey(b.mint),
    new TextEncoder().encode(JSON.stringify(document)),
    "application/json",
    b.creator,
  );

  return NextResponse.json({ uri: metadataUri(b.mint), image, metadata: document });
}
