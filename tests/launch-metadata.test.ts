/**
 * Metadata Coorwa hosts for its own launches.
 *
 * Three things here are load bearing and cheap to get wrong. The message a creator signs names the
 * mint, so a signature cannot be lifted from one launch and spent on another. The bytes are sniffed
 * rather than trusted, because whatever is stored is served back from coorwa.fun. And the uri has
 * to fit the 200 bytes the program allows, which no amount of testing later would fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bs58 from "bs58";
import {
  MAX_IMAGE_BYTES,
  imageKey,
  imageUri,
  isAddress,
  metadataDocument,
  metadataKey,
  metadataMessage,
  metadataUri,
  sniffImageType,
} from "../src/lib/launch-metadata";
import { verifyMetadataSignature } from "../src/lib/launch-store";

/** A stand-in wallet: a raw ed25519 key, addressed the way Solana addresses one. */
function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: bs58.encode(raw),
    sign: (msg: string) => bs58.encode(crypto.sign(null, Buffer.from(msg, "utf8"), privateKey)),
  };
}

const MINT = "DT7Jds9LADV82pdKyDBcYPDfb7vaKvHcbyEG48zxuvZq";
const OTHER_MINT = "83cPao5iemCJ6dj9ni7KXGo7JCVHtQu2jfMVuD7ywdYg";
const TS = 1789063348;

test("the message names the mint and the wallet, in one fixed shape", () => {
  assert.equal(
    metadataMessage("9S8Br5Tw95Y17gRJUvEcqFpcpVHMgHPhQFBtc91DEGoo", MINT, TS),
    `Coorwa launch metadata\ndomain: coorwa.fun\nmint: ${MINT}\nwallet: 9S8Br5Tw95Y17gRJUvEcqFpcpVHMgHPhQFBtc91DEGoo\nts: ${TS}`,
  );
});

test("a wallet that signed for its own mint verifies", () => {
  const w = wallet();
  const signature = w.sign(metadataMessage(w.address, MINT, TS));
  assert.equal(verifyMetadataSignature({ wallet: w.address, mint: MINT, ts: TS, signature }), true);
});

test("a signature cannot be moved to another mint", () => {
  const w = wallet();
  const signature = w.sign(metadataMessage(w.address, MINT, TS));
  assert.equal(
    verifyMetadataSignature({ wallet: w.address, mint: OTHER_MINT, ts: TS, signature }),
    false,
  );
});

test("a signature cannot be claimed by another wallet", () => {
  const signer = wallet();
  const impostor = wallet();
  const signature = signer.sign(metadataMessage(signer.address, MINT, TS));
  assert.equal(
    verifyMetadataSignature({ wallet: impostor.address, mint: MINT, ts: TS, signature }),
    false,
  );
});

test("a timestamp that drifted from the signed one fails", () => {
  const w = wallet();
  const signature = w.sign(metadataMessage(w.address, MINT, TS));
  assert.equal(
    verifyMetadataSignature({ wallet: w.address, mint: MINT, ts: TS + 1, signature }),
    false,
  );
});

test("nonsense is not a verified signature", () => {
  assert.equal(
    verifyMetadataSignature({ wallet: "not-a-wallet", mint: MINT, ts: TS, signature: "no" }),
    false,
  );
});

/** The first bytes of each format, which is all the sniffer reads. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

test("each format is recognised by its own bytes", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(GIF), "image/gif");
  assert.equal(sniffImageType(WEBP), "image/webp");
});

test("anything else is not an image, however it is labelled", () => {
  const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
  assert.equal(sniffImageType(html), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
  // A RIFF container that is not WebP, which is the one near miss worth pinning.
  assert.equal(
    sniffImageType(
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]),
    ),
    null,
  );
});

test("an address is base58 and nothing that could walk out of its key", () => {
  assert.equal(isAddress(MINT), true);
  assert.equal(isAddress("../../etc/passwd"), false);
  assert.equal(isAddress("short"), false);
  // 0, O, I and l are not in base58, so a lookalike address is refused too.
  assert.equal(isAddress("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"), false);
});

test("the document carries what a wallet looks for, and nothing empty", () => {
  const doc = metadataDocument({
    mint: MINT,
    name: "Cookie Lab",
    symbol: "cookl",
    description: "A token",
    image: imageUri(MINT),
    imageType: "image/png",
    pair: "NVDA",
  });
  assert.equal(doc.name, "Cookie Lab");
  assert.equal(doc.symbol, "COOKL");
  assert.equal(doc.image, `https://coorwa.fun/t/${MINT}/image`);
  assert.equal(doc.external_url, `https://coorwa.fun/terminal/${MINT}-nvda`);
  assert.deepEqual(doc.properties, {
    files: [{ uri: `https://coorwa.fun/t/${MINT}/image`, type: "image/png" }],
    category: "image",
  });
});

test("a launch with no picture and no pair yet still makes a valid document", () => {
  const doc = metadataDocument({ mint: MINT, name: "Cookie Lab", symbol: "COOKL" });
  assert.equal("image" in doc, false);
  assert.equal("description" in doc, false);
  assert.equal("properties" in doc, false);
  assert.equal(doc.external_url, "https://coorwa.fun/terminal");
  // Whatever is missing, the document is still JSON a wallet can read.
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

test("the uri fits the 200 bytes the program allows for one", () => {
  // The longest address base58 can spell, so the bound holds for every mint and not just this one.
  const longest = "1".repeat(44);
  assert.ok(metadataUri(longest).length <= 200, metadataUri(longest));
  assert.ok(imageUri(longest).length <= 200, imageUri(longest));
});

test("keys are namespaced by what they hold", () => {
  assert.equal(metadataKey(MINT), `t/${MINT}.json`);
  assert.equal(imageKey(MINT), `i/${MINT}`);
});

test("the image cap is the 2 MB the launch form already enforces", () => {
  assert.equal(MAX_IMAGE_BYTES, 2 * 1024 * 1024);
});
