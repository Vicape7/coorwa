/**
 * Where hosted metadata is kept, and who is allowed to write it. Server side only.
 *
 * Split from `launch-metadata.ts` because the launch page builds the message a creator signs in the
 * browser, and node's crypto and an R2 binding have no business being bundled into a page. What is
 * here is the half that only ever runs on a request: checking that signature, and the bucket.
 *
 * A document can be rewritten only while its mint does not exist on chain, which the route
 * enforces. Once the launch has landed, what the uri returns is as fixed as the tax on the mint.
 */
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { metadataMessage } from "./launch-metadata";

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
