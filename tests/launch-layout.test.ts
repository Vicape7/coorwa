/**
 * The launch client's wire format against the program's own.
 *
 * `src/lib/launch-program.ts` hand-encodes every instruction so the app never ships the program's IDL
 * to the browser. That is only safe if something checks the two agree, so this recomputes each
 * discriminator the way Anchor derives it and reads the built IDL back for the rest. A change to the
 * program that the client has not followed fails here rather than on chain.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATOR,
  DAMM_POOL_AUTHORITY,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  buyIx,
  claimCurveFeesIx,
  claimPoolFeesIx,
  dammEventAuthority,
  graduateIx,
  graduateIntoPoolIx,
  initializeConfigIx,
  isqrt,
  launchIx,
  sellIx,
  updateConfigIx,
} from "../src/lib/launch-program";

const idl = JSON.parse(
  readFileSync(new URL("../programs/corwa-launch/idl.json", import.meta.url), "utf8"),
) as {
  address: string;
  instructions: { name: string; discriminator: number[] }[];
  accounts: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string }[];
};

const anchorHash = (prefix: string, name: string) =>
  Array.from(createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8));

const key = () => Keypair.generate().publicKey;
const params = {
  feeRecipient: key(),
  withholdAuthority: key(),
  curveFeeBps: 100,
  creatorLpShareBps: 4000,
  taxTiers: [100, 200, 300, 0] as [number, number, number, number],
  graduationQuote: 1_000_000n,
  saleBase: 800n,
  migrationBase: 200n,
  virtualQuote: 333n,
  virtualBase: 1066n,
  tokenDecimals: 6,
  paused: false,
  dammConfig: key(),
};

/** Every instruction the client can build, next to the name Anchor dispatches it under. */
function built() {
  const mint = key();
  const quoteMint = key();
  const trade = {
    trader: key(),
    mint,
    quoteMint,
    traderBase: key(),
    traderQuote: key(),
  };
  return [
    ["initialize_config", initializeConfigIx(key(), quoteMint, params)],
    ["update_config", updateConfigIx(key(), params)],
    [
      "launch",
      launchIx({
        creator: key(),
        mint,
        quoteMint,
        name: "Name",
        symbol: "SYM",
        uri: "https://example.invalid/t.json",
        taxBps: 100,
      }),
    ],
    ["buy", buyIx(trade, 1n, 0n)],
    ["sell", sellIx(trade, 1n, 0n)],
    [
      "graduate",
      graduateIx({
        mint,
        quoteMint,
        positionNftMint: key(),
        liquidity: 2n ** 100n,
        sqrtPrice: 2n ** 70n,
      }),
    ],
    [
      "graduate_into_pool",
      graduateIntoPoolIx({
        mint,
        quoteMint,
        positionNftMint: key(),
        liquidity: 2n ** 100n,
        swapIn: 1n,
      }),
    ],
    ["claim_curve_fees", claimCurveFeesIx(mint, quoteMint, key())],
    [
      "claim_pool_fees",
      claimPoolFeesIx({
        mint,
        quoteMint,
        creator: key(),
        positionNftMint: key(),
        creatorQuote: key(),
        platformQuote: key(),
        creatorBase: key(),
        platformBase: key(),
      }),
    ],
  ] as const;
}

test("every instruction carries the discriminator Anchor derives from its name", () => {
  for (const [name, ix] of built()) {
    assert.deepEqual(
      Array.from(ix.data.subarray(0, 8)),
      anchorHash("global", name),
      `${name} is dispatched under the wrong eight bytes`,
    );
  }
});

test("the client and the built program agree on every discriminator", () => {
  const fromIdl = new Map(idl.instructions.map((i) => [i.name, i.discriminator]));
  for (const [name, ix] of built()) {
    assert.deepEqual(
      Array.from(ix.data.subarray(0, 8)),
      fromIdl.get(name),
      `${name} disagrees with the IDL`,
    );
  }
  assert.deepEqual(
    Array.from(ACCOUNT_DISCRIMINATOR.config),
    idl.accounts.find((a) => a.name === "Config")?.discriminator,
  );
  assert.deepEqual(
    Array.from(ACCOUNT_DISCRIMINATOR.curve),
    idl.accounts.find((a) => a.name === "Curve")?.discriminator,
  );
  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.config), anchorHash("account", "Config"));
  assert.deepEqual(Array.from(ACCOUNT_DISCRIMINATOR.curve), anchorHash("account", "Curve"));
});

test("every instruction names its accounts in the order the program declares them", () => {
  // A wrong order is the failure that looks like a working transaction until it is not, so the
  // count and the fixed members are worth pinning.
  const byName = new Map(built().map(([name, ix]) => [name, ix]));

  const launch = byName.get("launch");
  assert.ok(launch);
  assert.equal(launch.keys.length, 12);
  assert.equal(launch.keys[11].pubkey.toBase58(), SystemProgram.programId.toBase58());
  assert.ok(launch.keys[2].isSigner, "the mint signs for its own address");
  assert.ok(launch.keys[7].isSigner, "and the creator pays");

  const graduate = byName.get("graduate");
  assert.ok(graduate);
  assert.equal(graduate.keys.length, 21);
  assert.equal(graduate.keys[8].pubkey.toBase58(), DAMM_POOL_AUTHORITY.toBase58());
  assert.equal(graduate.keys[15].pubkey.toBase58(), dammEventAuthority().toBase58());
  assert.ok(graduate.keys[11].isSigner, "the position NFT mint is a fresh keypair");
  assert.equal(graduate.data.length, 8 + 16 + 16, "two u128 arguments");

  // The same accounts as a fresh graduation: only what the program does with them differs.
  const into = byName.get("graduate_into_pool");
  assert.ok(into);
  assert.deepEqual(
    into.keys.map((k) => [k.isSigner, k.isWritable]),
    graduate.keys.map((k) => [k.isSigner, k.isWritable]),
  );
  assert.equal(into.data.length, 8 + 8 + 16, "a u64 and a u128");

  const claim = byName.get("claim_pool_fees");
  assert.ok(claim);
  assert.equal(claim.keys.length, 23);
  assert.equal(claim.data.length, 8, "no arguments: the split is the program's to decide");
});

test("the error codes the client may have to explain exist in the program", () => {
  const names = new Set(idl.errors.map((e) => e.name));
  for (const expected of [
    "TaxTierNotOffered",
    "CurveClosed",
    "SlippageExceeded",
    "NotGraduated",
    "NotPooled",
    "PriceMismatch",
    "SeedOutOfRange",
    "WrongPosition",
  ]) {
    assert.ok(names.has(expected), `the program no longer has ${expected}`);
  }
});

test("the integer square root matches the program's, including at the edges", () => {
  for (const v of [0n, 1n, 2n, 3n, 4n, 9n, 10n, 1n << 64n, (1n << 128n) - 1n]) {
    const r = isqrt(v);
    assert.ok(r * r <= v, `isqrt(${v}) = ${r} is too big`);
    assert.ok((r + 1n) * (r + 1n) > v, `isqrt(${v}) = ${r} is too small`);
  }
});

test("the pool's price bounds are the ones the program was built against", () => {
  const constants = idl as unknown as { constants?: { name: string; value: string }[] };
  const poolAuthority = constants.constants?.find((c) => c.name === "POOL_AUTHORITY");
  assert.ok(poolAuthority, "the program should publish the pool authority it calls");
  assert.ok(poolAuthority.value.includes(DAMM_POOL_AUTHORITY.toBase58()));
  assert.equal(MIN_SQRT_PRICE, 4_295_048_016n);
  assert.equal(MAX_SQRT_PRICE, 79_226_673_521_066_979_257_578_248_091n);
  assert.ok(new PublicKey(idl.address));
});
