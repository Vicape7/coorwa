/**
 * Token metadata, hosted by Coorwa: the half both sides share.
 *
 * The MomoSwap launchpad pinned this to IPFS for us. Coorwa's own launch program writes the name,
 * the symbol and a uri into the mint itself (Token-2022's `TokenMetadata`), and that uri has to
 * point at something we serve, so there is one JSON document per mint and the image it names,
 * written while the launch is being built and read back afterwards by wallets, explorers and this
 * app.
 *
 * Everything here runs in the browser as well as on the server, because the page has to build the
 * exact message a creator signs rather than be handed one to sign blind. The signature check and
 * the bucket itself live in `launch-store.ts`, server side, where node's crypto and the R2 binding
 * are.
 */
import { curveSlug } from "./pair-slug";
import { SITE_ORIGIN } from "./config";

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
