/**
 * LP and creator fees taken as a stock: the decisions made before the first signature, and what a
 * claim leg hands the bridge.
 *
 * The route itself is the settlement executor and is exercised against real chains by hand. What
 * is pinned here is the arithmetic and the order of refusals, because each refusal exists to stop
 * a payout that would otherwise strand COOK on Solana halfway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  creatorClaimLeg,
  creatorPayoutSlug,
  lpClaimLeg,
  lpClaimedCook,
  lpPayoutSlug,
  lpToBridge,
  payoutBlocked,
  solNeeded,
  type SolanaReadiness,
} from "../src/lib/payout";
import { fundsLocation, newJourney } from "../src/lib/journey";
import type { RouteLeg } from "../src/lib/crosschain";

const COOK = 1_000_000_000n;
const RESERVE = COOK / 100n; // 0.01 COOK

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
  assert.match(payoutBlocked({ ...base, owedCook: 0, valueUsd: null })!, /No fees have accrued/);
  assert.match(payoutBlocked({ ...base, valueUsd: null, sol: null })!, /Pricing/);
  assert.match(payoutBlocked({ ...base, valueUsd: 0.46, sol: null })!, /starts at \$1/);
  assert.match(payoutBlocked({ ...base, sol: null })!, /Checking your SOL/);
});

test("a wallet short of SOL is told how much it needs and why", () => {
  const why = payoutBlocked({ ...base, sol: { balance: 0.001, needed: 0.0043, newAccounts: 2 } })!;
  assert.match(why, /about 0\.0043 SOL/);
  assert.match(why, /2 new token accounts/);
  assert.match(why, /Nothing has been signed/);

  const later = payoutBlocked({ ...base, sol: { balance: 0, needed: 0.0005, newAccounts: 0 } })!;
  assert.doesNotMatch(later, /token account/);
});

// --- LP fees taken as a stock ----------------------------------------------------------------------

test("an LP claim counts only the fees, not the wrapped COOK its closed account already held", () => {
  const rent = 2_039_280n;
  // No wrapped account before: the claim opened and closed one, so the gain is the fees net of fee.
  assert.equal(lpClaimedCook(3n * COOK - 5_000n, 0n), 3n * COOK - 5_000n);
  // The wallet already held 2 wrapped COOK: closing the account released it with its rent.
  assert.equal(lpClaimedCook(5n * COOK + rent - 5_000n, 2n * COOK + rent), 3n * COOK - 5_000n);
});

test("an LP payout bridges the claimed COOK plus the sale, and a costly claim is charged to it", () => {
  assert.equal(lpToBridge(3n * COOK, 4n * COOK, RESERVE), 7n * COOK - RESERVE);
  // A pool paying fees in the token alone: opening the token account cost COOK, and that is counted.
  assert.equal(lpToBridge(-2_000_000n, 4n * COOK, RESERVE), 4n * COOK - 2_000_000n - RESERVE);
  assert.ok(lpToBridge(RESERVE / 2n, 0n, RESERVE) <= 0n);
});

test("each position resumes on its own", () => {
  assert.notEqual(lpPayoutSlug("posA"), lpPayoutSlug("posB"));
});

test("the LP claim leg names the side that will be sold", () => {
  assert.equal(lpClaimLeg({ cookFee: 2, token: null }).label, "Claim your LP fees");
  const both = lpClaimLeg({ cookFee: 2, token: { symbol: "CHAT", amount: 150 } });
  assert.equal(both.kind, "lp-claim");
  assert.match(both.label, /CHAT and COOK/);
});

test("LP fees under the floor are sent back to a plain claim, in their own words", () => {
  assert.match(payoutBlocked({ ...base, owedCook: 0 })!, /No fees have accrued/);
  const why = payoutBlocked({ ...base, valueUsd: 0.46 })!;
  assert.match(why, /arrive as \$0\.46/);
  assert.match(why, /claim the fees as they are/);
});

test("a stopped LP payout says where the fees are at each step", () => {
  const leg = (kind: RouteLeg["kind"]): RouteLeg => ({ ...creatorClaimLeg(10), kind });
  const journey = newJourney({
    direction: "buy",
    owner: "owner",
    pairSlug: lpPayoutSlug("pos"),
    ticker: "NVDA",
    rwaMint: "mint",
    rwaDecimals: 8,
    token: { mint: "chat", symbol: "CHAT", decimals: 9 },
    input: { amount: 2, symbol: "COOK" },
    legs: [
      lpClaimLeg({ cookFee: 2, token: { symbol: "CHAT", amount: 150 } }),
      leg("cookie-swap"),
      leg("bridge"),
      leg("solana-swap"),
    ],
    lpClaim: { pool: "pool", position: "pos", positionNftAccount: "nft" },
  });

  assert.match(fundsLocation({ ...journey, cursor: 0 }), /still in your position/);
  assert.match(fundsLocation({ ...journey, cursor: 1 }), /as CHAT and COOK/);
  assert.match(fundsLocation({ ...journey, cursor: 2 }), /still on Cookie Chain, as COOK/);
  assert.match(fundsLocation({ ...journey, cursor: 3, bridgeAmount: 7 }), /taken 7 COOK/);
});

test("a creator payout claims from its own pool and says where the fees are", () => {
  const first = creatorClaimLeg(5594);
  assert.equal(first.kind, "creator-claim");
  assert.notEqual(creatorPayoutSlug("pool"), lpPayoutSlug("pool"));

  const leg = (kind: RouteLeg["kind"]): RouteLeg => ({ ...first, kind });
  const journey = newJourney({
    direction: "buy",
    owner: "owner",
    pairSlug: creatorPayoutSlug("pool"),
    ticker: "NVDA",
    rwaMint: "mint",
    rwaDecimals: 8,
    token: { mint: "cook", symbol: "COOK", decimals: 9 },
    input: { amount: 5594, symbol: "COOK" },
    legs: [first, leg("bridge"), leg("solana-swap")],
    creatorClaim: { pool: "pool" },
  });
  assert.match(fundsLocation({ ...journey, cursor: 0 }), /still on your launchpad pool/);
  assert.match(fundsLocation({ ...journey, cursor: 1 }), /still on Cookie Chain, as COOK/);
});
