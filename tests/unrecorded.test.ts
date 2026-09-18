/**
 * A payment that landed and was not recorded.
 *
 * The page keeps the report and offers to send it again, so the one rule that matters is which
 * answers end that offer. Forgetting a payment that could still be recorded makes the creator pay
 * twice; keeping one the server has refused for good leaves a button that can never work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clearUnrecorded, postRecord, saveUnrecorded } from "../src/lib/unrecorded";

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("a recorded pair ends the offer", async () => {
  answer(200, { recorded: true, pair: "NVDA" });
  const res = await postRecord("/api/listings", {});
  assert.equal(res.ok, true);
});

test("a 409 is final: the token has a pair, or the payment was used", async () => {
  answer(409, { error: "this token is already paired with TSLA" });
  const res = await postRecord("/api/listings", {});
  assert.deepEqual(res, { ok: false, final: true, error: "this token is already paired with TSLA" });
});

test("a token whose pool is not ready keeps its payment for later", async () => {
  answer(425, { error: "send the same payment again once it has one" });
  const res = await postRecord("/api/listings", {});
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.final, false);
});

test("a server error or a lost connection keeps the payment", async () => {
  answer(502, { error: "could not record the pair" });
  const failed = await postRecord("/api/listings", {});
  assert.equal(!failed.ok && failed.final, false);

  answer(502, "not json at all");
  const garbled = await postRecord("/api/listings", {});
  assert.equal(!garbled.ok && garbled.final, false);

  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const offline = await postRecord("/api/listings", {});
  assert.deepEqual(offline, { ok: false, final: false, error: "Coorwa could not be reached" });
});

test("a 200 that carries an error is not a success", async () => {
  answer(200, { error: "something went wrong" });
  const res = await postRecord("/api/listings", {});
  assert.equal(res.ok, false);
});

test("a kept report survives in storage until it is cleared, and only that one goes", () => {
  const items = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    },
  };
  try {
    saveUnrecorded("pair", "MintA", { body: { signature: "s1" }, error: "e" });
    saveUnrecorded("launch", "MintA", { body: { signature: "s2" }, error: "e" });
    clearUnrecorded("pair", "MintA");
    const left = JSON.parse(items.get("coorwa-unrecorded") ?? "{}");
    assert.deepEqual(Object.keys(left), ["launch:MintA"]);

    clearUnrecorded("launch", "MintA");
    assert.equal(items.has("coorwa-unrecorded"), false);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
