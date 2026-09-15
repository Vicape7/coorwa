/**
 * The accounting behind an epoch.
 *
 * The tree is already covered by `merkle.test.ts`; what is left is the arithmetic that decides
 * what goes into it, and that is where a bug costs real money rather than a failed transaction.
 * Paying a balance twice, paying an amount the vault cannot back, or handing out a proof the
 * program will not accept are all silent until somebody claims.
 *
 * Offline by design: the netting is a pure function of three maps, so none of this needs Postgres.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  entitlementsFrom,
  listingSharesFrom,
  listingsPerPair,
  toCook,
  type Accrual,
} from "../src/lib/epochs";
import { buildEpochTree, verifyProof } from "../src/lib/merkle";
import {
  CASHBACK_MIN_CLAIM_COOK,
  CASHBACK_SPLIT,
  SWAP_CASHBACK_SPLIT,
  COOK_DECIMALS,
} from "../src/lib/config";

const COOK_USD = 0.5;
const UNITS = 10 ** COOK_DECIMALS;

const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();

function accrual(over: Partial<Accrual> = {}): Accrual {
  return {
    traderUsd: new Map(),
    creatorUsd: new Map(),
    committedUsd: new Map(),
    cookPriceUsd: COOK_USD,
    ...over,
  };
}

/**
 * A share big enough to clear the claim floor several times over.
 *
 * These are shares, not fees: the split moved out to `computeEntitlements`, where the source of the
 * fee is known, because a launchpad referral and a swap fee are not split the same way. What is
 * left here is the part that must not be wrong whatever the split was - the subtraction, the
 * conversion and the floor.
 */
const TRADER_SHARE = CASHBACK_MIN_CLAIM_COOK * COOK_USD * 20;
const CREATOR_SHARE = TRADER_SHARE * (CASHBACK_SPLIT.creator / CASHBACK_SPLIT.trader);

test("a wallet is paid its share of what it generated, converted once", () => {
  const [line] = entitlementsFrom(accrual({ traderUsd: new Map([[A, TRADER_SHARE]]) }));

  assert.equal(line.wallet, A);
  assert.equal(line.traderUsd, TRADER_SHARE);
  assert.equal(line.creatorUsd, 0);
  assert.equal(line.amountUsd, TRADER_SHARE);
  assert.equal(line.amountRaw, BigInt(Math.floor((line.amountUsd / COOK_USD) * UNITS)));
});

test("trading and launching add up on the same line", () => {
  const [line] = entitlementsFrom(
    accrual({
      traderUsd: new Map([[A, TRADER_SHARE]]),
      creatorUsd: new Map([[A, CREATOR_SHARE]]),
    }),
  );

  // One leaf per wallet per epoch, because the program pays a wallet once and the merkle builder
  // refuses a duplicate outright.
  assert.equal(line.amountUsd, TRADER_SHARE + CREATOR_SHARE);
});

test("a balance already sitting in an epoch is not offered again", () => {
  const earned = TRADER_SHARE;
  const base = { traderUsd: new Map([[A, TRADER_SHARE]]) };

  // The whole balance is committed, so there is nothing left to publish.
  assert.deepEqual(
    entitlementsFrom(accrual({ ...base, committedUsd: new Map([[A, earned]]) })),
    [],
  );

  // Half of it is, so only the other half is.
  const [line] = entitlementsFrom(accrual({ ...base, committedUsd: new Map([[A, earned / 2]]) }));
  assert.ok(Math.abs(line.amountUsd - earned / 2) < 1e-9);
});

test("a wallet that has been paid more than it earned is skipped, never negative", () => {
  const lines = entitlementsFrom(
    accrual({
      traderUsd: new Map([[A, TRADER_SHARE]]),
      committedUsd: new Map([[A, TRADER_SHARE * 10]]),
    }),
  );
  assert.deepEqual(lines, []);
});

test("dust waits for a later epoch instead of costing its claimant rent", () => {
  // Just under the floor: a claim writes two accounts the claimant pays for, so paying this out
  // would leave them worse off than not claiming.
  const justUnder = (CASHBACK_MIN_CLAIM_COOK - 0.001) * COOK_USD;
  assert.deepEqual(entitlementsFrom(accrual({ traderUsd: new Map([[A, justUnder]]) })), []);

  const justOver = (CASHBACK_MIN_CLAIM_COOK + 0.001) * COOK_USD;
  const [line] = entitlementsFrom(accrual({ traderUsd: new Map([[A, justOver]]) }));
  assert.ok(toCook(line.amountRaw) >= CASHBACK_MIN_CLAIM_COOK);
});

test("the same inputs always produce the same root", () => {
  const input = accrual({
    traderUsd: new Map([
      [A, TRADER_SHARE],
      [B, TRADER_SHARE * 3],
    ]),
    creatorUsd: new Map([[B, CREATOR_SHARE]]),
  });

  // Republishing after a crash has to land on the same root, or every proof handed out before it
  // stops working. Nothing about the order the maps were built in may leak into the tree.
  const first = entitlementsFrom(input);
  const second = entitlementsFrom(input);
  const root = (lines: typeof first) =>
    buildEpochTree(
      lines.map((l) => ({ wallet: l.wallet, amount: l.amountRaw })),
      7n,
    ).root;

  assert.ok(root(first).equals(root(second)));
});

test("a proof survives the trip to the browser as hex and back", () => {
  const lines = entitlementsFrom(
    accrual({
      traderUsd: new Map(
        Array.from({ length: 9 }, () => [Keypair.generate().publicKey.toBase58(), TRADER_SHARE]),
      ),
    }),
  );
  const index = 3n;
  const tree = buildEpochTree(
    lines.map((l) => ({ wallet: l.wallet, amount: l.amountRaw })),
    index,
  );

  for (const l of lines) {
    // The API serialises each node as hex and the rewards page parses it back before signing.
    const wire = tree.proofFor(l.wallet).map((n) => n.toString("hex"));
    const back = wire.map((h) => Buffer.from(h, "hex"));

    assert.ok(wire.every((h) => h.length === 64));
    assert.ok(verifyProof(tree.root, index, l.wallet, l.amountRaw, back));
  }
});

test("a missing COOK price is refused rather than guessed", () => {
  assert.throws(() => entitlementsFrom(accrual({ cookPriceUsd: 0 })), /COOK price/);
});

test("every split returns the whole fee, and the swap split holds nothing back", () => {
  // A split that does not sum to 1 either invents money or quietly keeps some. The launchpad's
  // holds a fifth for liquidity because that revenue is a referral share somebody else pays; the
  // swap fee comes out of the trader's own pocket, so all of it goes back.
  const launchpad = CASHBACK_SPLIT.trader + CASHBACK_SPLIT.creator + CASHBACK_SPLIT.liquidity;
  const swap = SWAP_CASHBACK_SPLIT.trader + SWAP_CASHBACK_SPLIT.creator;

  assert.ok(Math.abs(launchpad - 1) < 1e-9, `launchpad split sums to ${launchpad}`);
  assert.ok(Math.abs(swap - 1) < 1e-9, `swap split sums to ${swap}`);
  assert.equal(
    SWAP_CASHBACK_SPLIT.trader / SWAP_CASHBACK_SPLIT.creator,
    CASHBACK_SPLIT.trader / CASHBACK_SPLIT.creator,
    "the weighting between trader and creator should be the same either way",
  );
});

// --- listing fees ----------------------------------------------------------------------------------

const PAIR = "mintA|AAPL";
const day = (n: number) => new Date(Date.UTC(2026, 8, n));

test("a pair's listing fee goes to that pair's traders, in proportion to the fees they paid on it", () => {
  const shares = listingSharesFrom({
    listings: [{ pair: PAIR, paidUsd: 4, at: day(1) }],
    fills: [
      { pair: PAIR, wallet: "alice", feeUsd: 3, at: day(2) },
      { pair: PAIR, wallet: "bob", feeUsd: 1, at: day(2) },
      // Trading another pair earns nothing from this one's listing.
      { pair: "mintB|NVDA", wallet: "carol", feeUsd: 50, at: day(2) },
    ],
    boundaries: [day(10)],
  });
  assert.equal(shares.get("alice"), 3);
  assert.equal(shares.get("bob"), 1);
  assert.equal(shares.has("carol"), false);
});

test("a window nobody traded the pair in carries its listing money into the next one", () => {
  const listings = [{ pair: PAIR, paidUsd: 2, at: day(1) }];
  const fills = [{ pair: PAIR, wallet: "bob", feeUsd: 0.01, at: day(12) }];

  const first = listingSharesFrom({ listings, fills, boundaries: [day(10)] });
  assert.equal(first.size, 0);

  const second = listingSharesFrom({ listings, fills, boundaries: [day(10), day(20)] });
  assert.equal(second.get("bob"), 2);
});

test("a later trader never shrinks what an earlier window already gave", () => {
  const listings = [{ pair: PAIR, paidUsd: 1, at: day(1) }];
  const early = [{ pair: PAIR, wallet: "alice", feeUsd: 1, at: day(2) }];
  const late = [...early, { pair: PAIR, wallet: "bob", feeUsd: 99, at: day(12) }];

  const epoch1 = listingSharesFrom({ listings, fills: early, boundaries: [day(10)] });
  const epoch2 = listingSharesFrom({ listings, fills: late, boundaries: [day(10), day(20)] });
  assert.equal(epoch1.get("alice"), 1);
  assert.equal(epoch2.get("alice"), 1);
  // Nothing new was listed in the second window, so there is nothing for bob, and in total the
  // pair has paid out exactly what it brought in.
  assert.equal(epoch2.has("bob"), false);
});

test("money listed after the cutoff, or fills without a fee, count for nothing yet", () => {
  const shares = listingSharesFrom({
    listings: [{ pair: PAIR, paidUsd: 5, at: day(11) }],
    fills: [
      { pair: PAIR, wallet: "alice", feeUsd: 1, at: day(2) },
      { pair: PAIR, wallet: "bob", feeUsd: 0, at: day(2) },
    ],
    boundaries: [day(10)],
  });
  assert.equal(shares.size, 0);
});

test("one payment that bought three pairs is a third of the money per pair", () => {
  const rows = ["AAPL", "TSLA", "SPY"].map((ticker) => ({
    mint: "mintA",
    ticker,
    signature: "sig1",
    paidUsd: 3.06,
    at: day(1),
  }));
  const per = listingsPerPair(rows);
  assert.deepEqual(
    per.map((l) => [l.pair, Number(l.paidUsd.toFixed(2))]),
    [
      ["mintA|AAPL", 1.02],
      ["mintA|TSLA", 1.02],
      ["mintA|SPY", 1.02],
    ],
  );
});
