/**
 * The launchpad login.
 *
 * MomoSwap gates the launch path behind a signed message and rejects everything it dislikes with
 * the same `401 Invalid signature`, which tells a user nothing. Coorwa verifies the signature itself
 * first so the page can name the cause, and these cases pin the two mistakes worth separating: a
 * wallet signing with a different account than it reports, and a message that drifted from the one
 * the server issued. The message format itself is part of the upstream contract, so it is asserted
 * literally rather than rebuilt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bs58 from "bs58";
import { loginMessage, verifyLoginSignature } from "../src/lib/launchpad";

/** A stand-in wallet: a raw ed25519 key, addressed the way Solana addresses one. */
function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: bs58.encode(raw),
    sign: (msg: string) => bs58.encode(crypto.sign(null, Buffer.from(msg, "utf8"), privateKey)),
  };
}

const NONCE = "7eb6264f123ce46b0be610509cad14c1c56821b03fa858e1";
const TS = 1789063348;

test("the message is exactly what the launchpad re-derives", () => {
  assert.equal(
    loginMessage("9S8Br5Tw95Y17gRJUvEcqFpcpVHMgHPhQFBtc91DEGoo", TS, NONCE),
    `MOMO Login\ndomain: momoswap.fun\nnonce: ${NONCE}\nwallet: 9S8Br5Tw95Y17gRJUvEcqFpcpVHMgHPhQFBtc91DEGoo\nts: ${TS}`,
  );
});

test("a wallet that signed the message it was given verifies", () => {
  const w = wallet();
  const signature = w.sign(loginMessage(w.address, TS, NONCE));

  assert.ok(verifyLoginSignature({ wallet: w.address, ts: TS, nonce: NONCE, signature }));
});

test("signing with a different account than the one connected does not verify", () => {
  const connected = wallet();
  const other = wallet();
  // The message names the connected wallet; the signature comes from the other one.
  const signature = other.sign(loginMessage(connected.address, TS, NONCE));

  assert.equal(
    verifyLoginSignature({ wallet: connected.address, ts: TS, nonce: NONCE, signature }),
    false,
  );
});

test("any drift in the signed message is caught", () => {
  const w = wallet();

  for (const [what, message] of [
    ["a changed nonce", loginMessage(w.address, TS, "0000")],
    ["a changed timestamp", loginMessage(w.address, TS + 1, NONCE)],
    ["a wallet prefix the wallet added itself", `Coorwa: ${loginMessage(w.address, TS, NONCE)}`],
    [
      "fields in another order",
      `MOMO Login\ndomain: momoswap.fun\nwallet: ${w.address}\nnonce: ${NONCE}\nts: ${TS}`,
    ],
  ] as const) {
    assert.equal(
      verifyLoginSignature({ wallet: w.address, ts: TS, nonce: NONCE, signature: w.sign(message) }),
      false,
      `${what} should not verify`,
    );
  }
});

test("a malformed address or signature is refused rather than thrown", () => {
  const w = wallet();
  const good = w.sign(loginMessage(w.address, TS, NONCE));

  assert.equal(
    verifyLoginSignature({ wallet: "not-an-address", ts: TS, nonce: NONCE, signature: good }),
    false,
  );
  assert.equal(
    verifyLoginSignature({ wallet: w.address, ts: TS, nonce: NONCE, signature: "!!" }),
    false,
  );
  assert.equal(verifyLoginSignature({ wallet: "", ts: TS, nonce: NONCE, signature: "" }), false);
});
