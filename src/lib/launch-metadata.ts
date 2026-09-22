/**
 * Token metadata, hosted by Coorwa.
 *
 * The MomoSwap launchpad pinned this to IPFS for us. Coorwa's own launch program writes the name,
 * the symbol and a uri into the mint itself (Token-2022's `TokenMetadata`), and that uri has to
 * point at something we serve, so this file is the store behind it: one JSON document per mint and
 * the image it names, written while the launch is being built and read back afterwards by wallets,
 * explorers and this app.
 *
 * Two rules hold the thing together. The creator signs for the mint they are about to launch, so
 * nobody can write metadata for someone else's token or use the bucket as free storage. And a
 * document can only be rewritten while its mint does not exist on chain yet: once the launch has
 * landed, what the uri returns is as fixed as the tax on the mint.
 */
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { SITE_ORIGIN } from "./config";
import { curveSlug } from "./curve-pairs";

/** The largest image a launch may carry, matching what the launch form already refuses to exceed. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** What a browser will actually render, mapped to the extension the stored key carries. */
export const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;

export function isImageType(value: string): value is ImageType {
  return value in IMAGE_TYPES;
}

/**
 * What the bytes actually are, whatever the request called them.
 *
 * A content type is a claim by the caller, and this store hands its objects back with the type it
 * was told. Reading the first bytes is the cheap way to keep an HTML page or a script from being
 * served from coorwa.fun as an image.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Base58, 32 bytes: an address and nothing that could walk out of its own key. */
export function isAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

// --- the signature that gates a write -------------------------------------------------------------

/** How long a signed message stays good. Past it the message is stale, not wrong. */
export const MESSAGE_TTL_SECS = 300;

/**
 * What a creator signs before their metadata is stored. It names the mint, so a signature taken
 * from one launch cannot be replayed onto another.
 */
export function metadataMessage(wallet: string, mint: string, ts: number): string {
  return `Coorwa launch metadata\ndomain: coorwa.fun\nmint: ${mint}\nwallet: ${wallet}\nts: ${ts}`;
}

/** A raw ed25519 key wrapped as DER, which is the only shape node's verifier accepts. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyMetadataSignature(args: {
  wallet: string;
  mint: string;
  ts: number;
  signature: string;
}): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(bs58.decode(args.wallet))]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(metadataMessage(args.wallet, args.mint, args.ts), "utf8"),
      key,
      Buffer.from(bs58.decode(args.signature)),
    );
  } catch {
    // A malformed address or signature is not a verified one, which is all the caller needs.
    return false;
  }
}

// --- the document ---------------------------------------------------------------------------------

export interface MetadataInput {
  mint: string;
  name: string;
  symbol: string;
  description?: string;
  /** Absolute url of the image, ours or the creator's own. */
  image?: string | null;
  imageType?: ImageType;
  /** Ticker of the stock the token is paired with, if it is already chosen. */
  pair?: string | null;
}

/**
 * The JSON a wallet reads. The field names are the ones every Solana wallet and explorer already
 * looks for, so a Coorwa token shows its name and picture everywhere, not only here.
 */
export function metadataDocument(input: MetadataInput): Record<string, unknown> {
  const symbol = input.symbol.toUpperCase();
  const doc: Record<string, unknown> = {
    name: input.name,
    symbol,
    description: input.description || undefined,
    image: input.image || undefined,
    external_url: input.pair
      ? `${SITE_ORIGIN}/terminal/${curveSlug(input.mint, input.pair)}`
      : `${SITE_ORIGIN}/terminal`,
  };
  if (input.image && input.imageType) {
    doc.properties = {
      files: [{ uri: input.image, type: input.imageType }],
      category: "image",
    };
  }
  // Undefined keys would serialise away anyway; dropping them keeps the stored bytes honest.
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));
}

/** Where the mint points. Under 200 bytes, which is all the program allows for a uri. */
export function metadataUri(mint: string): string {
  return `${SITE_ORIGIN}/t/${mint}`;
}

export function imageUri(mint: string): string {
  return `${SITE_ORIGIN}/t/${mint}/image`;
}

export function metadataKey(mint: string): string {
  return `t/${mint}.json`;
}

export function imageKey(mint: string): string {
  return `i/${mint}`;
}

// --- the store ------------------------------------------------------------------------------------

export interface StoredObject {
  body: Uint8Array;
  contentType: string;
  /** The wallet that wrote it, so only that wallet can rewrite it. */
  creator: string | null;
}

export interface MetadataStore {
  head(key: string): Promise<{ creator: string | null } | null>;
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: Uint8Array, contentType: string, creator: string): Promise<void>;
}

/** Only the parts of R2 this file touches, declared here so no types package is needed. */
interface R2Object {
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}
interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

/**
 * What the OpenNext worker puts on the global scope for the request being served, read through the
 * symbol rather than `getCloudflareContext` for the same reason `src/lib/db/index.ts` does it: so
 * `next dev` and the test runner never load the adapter at all.
 */
function bucket(): R2Bucket | undefined {
  const cf = (globalThis as Record<symbol, { env?: { METADATA?: R2Bucket } } | undefined>)[
    Symbol.for("__cloudflare-context__")
  ];
  return cf?.env?.METADATA;
}

function r2Store(b: R2Bucket): MetadataStore {
  return {
    async head(key) {
      const object = await b.head(key);
      return object ? { creator: object.customMetadata?.creator ?? null } : null;
    },
    async get(key) {
      const object = await b.get(key);
      if (!object) return null;
      return {
        body: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
        creator: object.customMetadata?.creator ?? null,
      };
    },
    async put(key, body, contentType, creator) {
      await b.put(key, body, {
        httpMetadata: { contentType, cacheControl: "public, max-age=3600" },
        customMetadata: { creator },
      });
    },
  };
}

/**
 * Development has no bucket, so it writes files instead.
 *
 * Only ever reached when the R2 binding is missing, which on Cloudflare means the binding was left
 * out of wrangler.jsonc rather than that the store is optional. Keeping it here is what lets a
 * launch be built and read back end to end with `next dev`.
 */
function fileStore(): MetadataStore {
  const dir = `${process.cwd()}/.coorwa-metadata`;
  const flat = (key: string) => `${dir}/${key.replace(/\//g, "__")}`;
  const fs = () => import("node:fs/promises");

  return {
    async head(key) {
      try {
        const side = JSON.parse(await (await fs()).readFile(`${flat(key)}.headers`, "utf8"));
        return { creator: side.creator ?? null };
      } catch {
        return null;
      }
    },
    async get(key) {
      try {
        const mod = await fs();
        const body = await mod.readFile(flat(key));
        const side = JSON.parse(await mod.readFile(`${flat(key)}.headers`, "utf8"));
        return {
          body: new Uint8Array(body),
          contentType: side.contentType ?? "application/octet-stream",
          creator: side.creator ?? null,
        };
      } catch {
        return null;
      }
    },
    async put(key, body, contentType, creator) {
      const mod = await fs();
      await mod.mkdir(dir, { recursive: true });
      await mod.writeFile(flat(key), body);
      await mod.writeFile(`${flat(key)}.headers`, JSON.stringify({ contentType, creator }));
    },
  };
}

/**
 * The store for this request, or null when there is nowhere to write.
 *
 * Null is a real answer rather than a thrown error: the app runs fine without it, right up until
 * someone tries to launch, and the route turns it into a message that names the missing binding.
 */
export function metadataStore(): MetadataStore | null {
  const b = bucket();
  if (b) return r2Store(b);
  if (process.env.NODE_ENV === "production") return null;
  return fileStore();
}
