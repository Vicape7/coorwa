/**
 * Cashback taken as a stock: the decisions made before the first signature, and what the claim leg
 * hands the bridge.
 *
 * The route itself is the settlement executor and is exercised against real chains by hand. What
 * is pinned here is the arithmetic and the order of refusals, because each refusal exists to stop
 * a payout that would otherwise strand COOK on Solana halfway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  claimLeg,
  claimedToBridge,
  payoutBlocked,
  proofBytes,
  solNeeded,
  type SolanaReadiness,
} from "../src/lib/payout";
import { fundsLocation, newJourney } from "../src/lib/journey";
import type { RouteLeg } from "../src/lib/crosschain";

const COOK = 1_000_000_000n;
const RESERVE = COOK / 100n; // 0.01 COOK

test("the claim leg bridges what came in, net of costs, and never more than was owed", () => {
  // The claims cost fees and a claim record, so less arrives than the epochs owe.
  assert.equal(claimedToBridge(5n * COOK, 6n * COOK, RESERVE), 5n * COOK - RESERVE);
  // COOK that arrived for some other reason while the claims ran is not swept into the payout.
  assert.equal(claimedToBridge(9n * COOK, 6n * COOK, RESERVE), 6n * COOK - RESERVE);
  // Too little to leave the bridge its own fee means nothing is worth bridging.
  assert.ok(claimedToBridge(RESERVE / 2n, 6n * COOK, RESERVE) <= 0n);
});

test("a first payout pays for two token accounts on Solana, a later one only for fees", () => {
  const fees = solNeeded({ cookAccount: true, rwaAccount: true });
  const first = solNeeded({ cookAccount: false, rwaAccount: false });
  assert.equal(fees, 0.0005);
  assert.equal(Number((first - fees).toFixed(9)), 0.003831465);
  assert.ok(solNeeded({ cookAccount: true, rwaAccount: false }) < first);
});

const ready: SolanaReadiness = { balance: 1, needed: 0.004, newAccounts: 2 };
const base = { rpcIsPublic: false, owedCook: 50_000, valueUsd: 4.2, sol: ready };

test("a payout that can go says nothing", () => {
  assert.equal(payoutBlocked(base), null);
});

test("refusals come in the order that makes the later ones moot", () => {
  assert.match(payoutBlocked({ ...base, rpcIsPublic: true, owedCook: 0 })!, /Solana RPC/);
  assert.match(payoutBlocked({ ...base, owedCook: 0, valueUsd: null })!, /Nothing is claimable/);
  assert.match(payoutBlocked({ ...base, valueUsd: null, sol: null })!, /Pricing/);
  assert.match(payoutBlocked({ ...base, valueUsd: 0.46, sol: null })!, /starts at \$1/);
  assert.match(payoutBlocked({ ...base, sol: null })!, /Checking your SOL/);
});

test("a payout under the floor is sent back to the COOK claim", () => {
  const why = payoutBlocked({ ...base, valueUsd: 0.46 })!;
  assert.match(why, /arrive as \$0\.46/);
  assert.match(why, /claim it as COOK/);
});

test("a wallet short of SOL is told how much it needs and why", () => {
  const why = payoutBlocked({ ...base, sol: { balance: 0.001, needed: 0.0043, newAccounts: 2 } })!;
  assert.match(why, /about 0\.0043 SOL/);
  assert.match(why, /2 new token accounts/);
  assert.match(why, /Nothing has been signed/);

  const later = payoutBlocked({ ...base, sol: { balance: 0, needed: 0.0005, newAccounts: 0 } })!;
  assert.doesNotMatch(later, /token account/);
});

test("a proof goes to the program as the bytes its hex spells", () => {
  assert.deepEqual(
    proofBytes(["00ff10", "ab"]).map((b) => Array.from(b)),
    [[0, 255, 16], [171]],
  );
});

test("a stopped payout says where the money is at each step", () => {
  const leg = (kind: RouteLeg["kind"]): RouteLeg => ({ ...claimLeg(10), kind });
  const journey = newJourney({
    direction: "buy",
    owner: "owner",
    pairSlug: "cashback",
    ticker: "NVDA",
    rwaMint: "mint",
    rwaDecimals: 8,
    token: { mint: "cook", symbol: "COOK", decimals: 9 },
    input: { amount: 10, symbol: "COOK" },
    legs: [claimLeg(10), leg("bridge"), leg("solana-swap")],
    claims: [{ epoch: "1", amountRaw: "10000000000", proof: [] }],
  });

  assert.match(fundsLocation({ ...journey, cursor: 0 }), /rest is still in the vault/);
  assert.match(fundsLocation({ ...journey, cursor: 1 }), /still on Cookie Chain, as COOK/);
  assert.match(fundsLocation({ ...journey, cursor: 2, bridgeAmount: 9.99 }), /taken 9\.99 COOK/);
});
