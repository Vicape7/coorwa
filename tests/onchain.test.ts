/**
 * What a transaction proves, read from real launchpad builds.
 *
 * These two predicates are what stops a stranger being paid a token's creator share and what ties a
 * curve fill to the curve it happened on, so the cases that matter are the ones where a transaction
 * names the right addresses and still is not the thing being claimed. A buy names the mint, the
 * pool and the trader, and every one of those checks passes on it; only the instruction it carries
 * and the mint's signature say that a launch is a launch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import {
  createsLaunchpadToken,
  instructionsOf,
  signersOf,
  tokenMoved,
  tradesOnCurve,
  type ProvenTransaction,
} from "../src/lib/onchain";
import { PROGRAM_IDS } from "../src/lib/config";

interface Fixture {
  request: { pool?: string };
  response: { transactionBase64: string; mint?: string; pool?: string };
}

function load(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/momoswap/${name}.json`, import.meta.url), "utf8"),
  );
}

/**
 * A build turned into what a confirmed transaction looks like to `onchain.ts`. The message is the
 * real one the launchpad built, which is the part every check here reads.
 */
function proofOf(fixture: Fixture): ProvenTransaction {
  const tx = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(fixture.response.transactionBase64, "base64")),
  );
  const keys = tx.message
    .getAccountKeys()
    .keySegments()
    .flat()
    .map((k) => k.toBase58());
  return {
    tx: {
      transaction: { message: tx.message },
      meta: {},
    } as unknown as VersionedTransactionResponse,
    keys,
    accounts: new Set(keys),
  };
}

test("a launch is the transaction that creates the mint and its pool", () => {
  const create = load("create");
  const proof = proofOf(create);
  const { mint, pool } = create.response;

  assert.ok(createsLaunchpadToken(proof, mint!, pool!));
  // The mint signs its own creation, which is what nobody else can reproduce later.
  assert.ok(signersOf(proof).has(mint!));
  assert.ok(instructionsOf(proof).some((ix) => ix.programId === PROGRAM_IDS.momoswapLaunchpad));
});

test("a launch with a dev buy is still a launch", () => {
  const create = load("create-dev-buy");
  const proof = proofOf(create);
  assert.ok(createsLaunchpadToken(proof, create.response.mint!, create.response.pool!));
});

test("a buy on a curve is not a launch, however many of the right addresses it names", () => {
  const buy = load("buy-referred");
  const proof = proofOf(buy);
  const pool = buy.request.pool!;

  // The trade really does name the pool, which is exactly why naming it cannot be the test.
  assert.ok(proof.accounts.has(pool));
  assert.ok(!createsLaunchpadToken(proof, [...proof.accounts][3], pool));
  for (const account of proof.accounts) {
    assert.ok(!createsLaunchpadToken(proof, account, pool), `${account} passed as a launch`);
  }
});

test("a launch does not count as a trade, and a trade counts only on its own pool", () => {
  const buy = proofOf(load("buy-referred"));
  const sell = proofOf(load("sell"));
  const create = load("create");

  assert.ok(tradesOnCurve(buy, load("buy-referred").request.pool!));
  assert.ok(tradesOnCurve(sell, load("sell").request.pool!));
  // Another pool's curve, and the launch itself, are both refused.
  assert.ok(!tradesOnCurve(buy, create.response.pool!));
  assert.ok(!tradesOnCurve(proofOf(create), create.response.pool!));
});

test("a claim of creator fees is neither a launch nor a trade", () => {
  const claim = load("claim-creator-fees");
  const proof = proofOf(claim);
  assert.ok(!tradesOnCurve(proof, claim.request.pool!));
  for (const account of proof.accounts) {
    assert.ok(!createsLaunchpadToken(proof, account, claim.request.pool!));
  }
});

test("a token only moved for the wallet whose accounts moved", () => {
  const proof = {
    tx: {
      meta: {
        preTokenBalances: [
          { owner: "alice", mint: "TOKEN", uiTokenAmount: { amount: "100" } },
          { owner: "bob", mint: "TOKEN", uiTokenAmount: { amount: "5" } },
        ],
        postTokenBalances: [
          { owner: "alice", mint: "TOKEN", uiTokenAmount: { amount: "250" } },
          { owner: "alice", mint: "OTHER", uiTokenAmount: { amount: "900" } },
          { owner: "bob", mint: "TOKEN", uiTokenAmount: { amount: "0" } },
        ],
      },
    },
    keys: [],
    accounts: new Set<string>(),
  } as unknown as ProvenTransaction;

  assert.equal(tokenMoved(proof, "alice", "TOKEN"), 150n);
  assert.equal(tokenMoved(proof, "bob", "TOKEN"), -5n);
  // A token the wallet never held on this transaction did not move, whatever else did.
  assert.equal(tokenMoved(proof, "carol", "TOKEN"), 0n);
  assert.equal(tokenMoved(proof, "bob", "OTHER"), 0n);
});
