/**
 * Client for the Coorwa launch program (`programs/corwa-launch`).
 *
 * Written against the wire format rather than a generated IDL, for the same reasons as
 * `src/lib/vault.ts`: the browser bundle stays small and a stale artefact can never quietly disagree
 * with the deployed program. `tests/launch-layout.test.ts` recomputes every discriminator here from
 * its name, so this file cannot drift without a test going red.
 *
 * Two things live here that are not just encoding. The quote functions mirror the program's curve
 * maths exactly, so the page can show a price without asking the chain. And `graduationParams` works
 * out the pool's opening price and liquidity, which the program deliberately does not compute
 * itself: it checks the result instead, so these numbers have to land inside its tolerances.
 */
import bs58 from "bs58";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { COOK_MINT, DAMM_POOL_CONFIG, DAMM_PROGRAM_ADDRESS, LAUNCH_PROGRAM_ADDRESS } from "./config";

export const LAUNCH_PROGRAM_ID = new PublicKey(LAUNCH_PROGRAM_ADDRESS);
export const DAMM_PROGRAM_ID = new PublicKey(DAMM_PROGRAM_ADDRESS);
export const DAMM_CONFIG = new PublicKey(DAMM_POOL_CONFIG);

/** The pool program's one fixed authority, which owns every pool's vaults. */
export const DAMM_POOL_AUTHORITY = new PublicKey("8WYfVSBcP3T1amRNmTnLfzYd44VDjGpw1jZxrEL8638o");

/** The bounds of a full-range position, in the Q64.64 form the pool stores prices in. */
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;

// --- discriminators ------------------------------------------------------------------------------

/** sha256("global:<instruction>")[0..8], the way Anchor dispatches. */
const IX = {
  initializeConfig: [208, 127, 21, 1, 194, 190, 196, 70],
  updateConfig: [29, 158, 252, 191, 10, 83, 219, 99],
  launch: [153, 241, 93, 225, 22, 69, 74, 61],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  graduate: [45, 235, 225, 181, 17, 218, 64, 130],
  graduateIntoPool: [139, 117, 187, 237, 216, 124, 119, 169],
  claimCurveFees: [67, 48, 233, 11, 25, 119, 172, 15],
  claimPoolFees: [33, 187, 125, 186, 41, 247, 236, 89],
} as const;

/**
 * The same discriminators as hex, which is how a transaction read back off the chain reads. Used to
 * tell a launch from any other transaction that merely names the same mint.
 */
export const LAUNCH_IX_HEX = Object.fromEntries(
  Object.entries(IX).map(([name, bytes]) => [name, Buffer.from(bytes).toString("hex")]),
) as Record<keyof typeof IX, string>;

/** sha256("event:<Name>")[0..8], as Anchor writes it in front of a `Program data:` log line. */
export const EVENT_DISCRIMINATOR = {
  traded: [225, 202, 73, 175, 147, 43, 160, 150],
} as const;

/** sha256("account:<Struct>")[0..8]. */
export const ACCOUNT_DISCRIMINATOR = {
  config: [155, 12, 170, 224, 30, 250, 204, 130],
  curve: [191, 180, 249, 66, 180, 71, 51, 182],
} as const;

// --- seeds and addresses -------------------------------------------------------------------------

const enc = new TextEncoder();
const CONFIG_SEED = enc.encode("config");
const CURVE_SEED = enc.encode("curve");
const AUTHORITY_SEED = enc.encode("authority");
const DAMM_POOL_SEED = enc.encode("pool");
const DAMM_POSITION_SEED = enc.encode("position");
const DAMM_POSITION_NFT_SEED = enc.encode("position_nft_account");
const DAMM_TOKEN_VAULT_SEED = enc.encode("token_vault");
const EVENT_AUTHORITY_SEED = enc.encode("__event_authority");

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], LAUNCH_PROGRAM_ID)[0];
}

/** One curve per mint, so nothing has to be looked up to find it. */
export function curvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CURVE_SEED, mint.toBytes()], LAUNCH_PROGRAM_ID)[0];
}

/**
 * The data-less address that holds a curve's vaults and pays for its pool.
 *
 * It carries no data on purpose: the pool program takes a new pool's tokens from accounts owned by
 * whoever pays the rent, and the system program will not move lamports out of an account that has
 * data. See the program's own note on `VaultAuthority`.
 */
export function vaultAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([AUTHORITY_SEED, mint.toBytes()], LAUNCH_PROGRAM_ID)[0];
}

export function baseVault(mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    vaultAuthorityPda(mint),
    true,
    TOKEN_2022_PROGRAM_ID,
  );
}

export function quoteVault(mint: PublicKey, quoteMint = new PublicKey(COOK_MINT)): PublicKey {
  return getAssociatedTokenAddressSync(quoteMint, vaultAuthorityPda(mint), true, TOKEN_PROGRAM_ID);
}

/** The pool program orders its own seeds by key, so a pool address does not depend on which side is which. */
export function dammPoolPda(a: PublicKey, b: PublicKey, config = DAMM_CONFIG): PublicKey {
  const [lo, hi] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  return PublicKey.findProgramAddressSync(
    [DAMM_POOL_SEED, config.toBytes(), hi.toBytes(), lo.toBytes()],
    DAMM_PROGRAM_ID,
  )[0];
}

export function dammPositionPda(positionNftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DAMM_POSITION_SEED, positionNftMint.toBytes()],
    DAMM_PROGRAM_ID,
  )[0];
}

export function dammPositionNftAccount(positionNftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DAMM_POSITION_NFT_SEED, positionNftMint.toBytes()],
    DAMM_PROGRAM_ID,
  )[0];
}

export function dammTokenVault(mint: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DAMM_TOKEN_VAULT_SEED, mint.toBytes(), pool.toBytes()],
    DAMM_PROGRAM_ID,
  )[0];
}

export function dammEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], DAMM_PROGRAM_ID)[0];
}

// --- encoding ------------------------------------------------------------------------------------

function u16le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u64le(value: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function u128le(value: bigint): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, value & 0xffffffffffffffffn, true);
  view.setBigUint64(8, value >> 64n, true);
  return out;
}

function stringle(value: string): Uint8Array {
  const bytes = enc.encode(value);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function concat(...parts: (Uint8Array | readonly number[])[]): Buffer {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return Buffer.from(out);
}

// --- state -------------------------------------------------------------------------------------

export interface LaunchConfigState {
  authority: PublicKey;
  feeRecipient: PublicKey;
  withholdAuthority: PublicKey;
  quoteMint: PublicKey;
  curveFeeBps: number;
  creatorLpShareBps: number;
  taxTiers: number[];
  graduationQuote: bigint;
  saleBase: bigint;
  migrationBase: bigint;
  virtualQuote: bigint;
  virtualBase: bigint;
  tokenDecimals: number;
  paused: boolean;
  bump: number;
  launchCount: bigint;
  dammConfig: PublicKey;
}

export interface CurveState {
  address: PublicKey;
  config: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  virtualBase: bigint;
  virtualQuote: bigint;
  saleBase: bigint;
  migrationBase: bigint;
  graduationQuote: bigint;
  baseSold: bigint;
  quoteRaised: bigint;
  feesQuote: bigint;
  taxBps: number;
  curveFeeBps: number;
  creatorLpShareBps: number;
  state: "live" | "graduated" | "pooled";
  createdAt: number;
  positionNftMint: PublicKey;
}

/**
 * Reads an account back, field by field.
 *
 * Through a DataView rather than Buffer's own readers: this runs in the page as well as on the
 * server, and the Buffer a bundler gives the browser is a polyfill that does not carry the 64-bit
 * readers. Reading a config in the browser threw on the first `u64` until this stopped using them.
 */
class Reader {
  private at = 8; // past the account discriminator
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  pubkey(): PublicKey {
    const key = new PublicKey(this.bytes.subarray(this.at, this.at + 32));
    this.at += 32;
    return key;
  }
  u8(): number {
    return this.bytes[this.at++];
  }
  bool(): boolean {
    return this.u8() === 1;
  }
  u16(): number {
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u64(): bigint {
    const v = this.view.getBigUint64(this.at, true);
    this.at += 8;
    return v;
  }
  i64(): bigint {
    const v = this.view.getBigInt64(this.at, true);
    this.at += 8;
    return v;
  }
}

export function decodeLaunchConfig(data: Uint8Array): LaunchConfigState {
  const r = new Reader(data);
  return {
    authority: r.pubkey(),
    feeRecipient: r.pubkey(),
    withholdAuthority: r.pubkey(),
    quoteMint: r.pubkey(),
    curveFeeBps: r.u16(),
    creatorLpShareBps: r.u16(),
    taxTiers: [r.u16(), r.u16(), r.u16(), r.u16()],
    graduationQuote: r.u64(),
    saleBase: r.u64(),
    migrationBase: r.u64(),
    virtualQuote: r.u64(),
    virtualBase: r.u64(),
    tokenDecimals: r.u8(),
    paused: r.bool(),
    bump: r.u8(),
    launchCount: r.u64(),
    dammConfig: r.pubkey(),
  };
}

const STATES = ["live", "graduated", "pooled"] as const;

export function decodeCurve(address: PublicKey, data: Uint8Array): CurveState {
  const r = new Reader(data);
  const out = {
    address,
    config: r.pubkey(),
    creator: r.pubkey(),
    mint: r.pubkey(),
    baseVault: r.pubkey(),
    quoteVault: r.pubkey(),
    virtualBase: r.u64(),
    virtualQuote: r.u64(),
    saleBase: r.u64(),
    migrationBase: r.u64(),
    graduationQuote: r.u64(),
    baseSold: r.u64(),
    quoteRaised: r.u64(),
    feesQuote: r.u64(),
    taxBps: r.u16(),
    curveFeeBps: r.u16(),
    creatorLpShareBps: r.u16(),
    state: STATES[r.u8()] ?? "live",
    createdAt: Number(r.i64()),
  };
  r.u8(); // bump
  return { ...out, positionNftMint: r.pubkey() };
}

export async function fetchCurve(
  connection: Connection,
  mint: PublicKey,
): Promise<CurveState | null> {
  const address = curvePda(mint);
  const info = await connection.getAccountInfo(address);
  return info ? decodeCurve(address, Buffer.from(info.data)) : null;
}

// --- events --------------------------------------------------------------------------------------

export interface TradedEvent {
  curve: PublicKey;
  mint: PublicKey;
  trader: PublicKey;
  isBuy: boolean;
  /** What the trader paid, or was paid, in quote units. Coorwa's fee is part of it. */
  quoteAmount: bigint;
  /** What the curve sent or received, before the mint's transfer tax. */
  baseAmount: bigint;
  fee: bigint;
  quoteRaised: bigint;
  baseSold: bigint;
  graduated: boolean;
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => data[i] === b);
}

/**
 * The trades a transaction's logs report.
 *
 * The program emits one `Traded` per fill with the amounts it actually moved, which is the only
 * honest source for a chart: balances alone cannot tell a buy inside a launch from the mint that
 * funded the vault in the same transaction, and instruction data says what was asked for rather
 * than what happened.
 */
export function tradedEvents(logs: string[] | undefined | null): TradedEvent[] {
  const out: TradedEvent[] = [];
  for (const line of logs ?? []) {
    const encoded = line.startsWith("Program data: ") ? line.slice(14) : null;
    if (!encoded) continue;
    let data: Uint8Array;
    try {
      data = fromBase64(encoded);
    } catch {
      continue;
    }
    if (data.length < 8 || !startsWith(data, EVENT_DISCRIMINATOR.traded)) continue;
    const r = new Reader(data);
    out.push({
      curve: r.pubkey(),
      mint: r.pubkey(),
      trader: r.pubkey(),
      isBuy: r.bool(),
      quoteAmount: r.u64(),
      baseAmount: r.u64(),
      fee: r.u64(),
      quoteRaised: r.u64(),
      baseSold: r.u64(),
      graduated: r.bool(),
    });
  }
  return out;
}

export async function fetchLaunchConfig(
  connection: Connection,
): Promise<LaunchConfigState | null> {
  const info = await connection.getAccountInfo(configPda());
  return info ? decodeLaunchConfig(Buffer.from(info.data)) : null;
}

/**
 * Every curve, or every curve one wallet created.
 *
 * Read straight off the program rather than out of a database, so a creator sees their launches
 * even on a deployment that stores nothing. The creator sits right after the discriminator and the
 * config in the account, which is what the offset below is.
 */
export async function fetchCurves(
  connection: Connection,
  creator?: PublicKey,
): Promise<CurveState[]> {
  const filters: { memcmp: { offset: number; bytes: string } }[] = [
    { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCOUNT_DISCRIMINATOR.curve)) } },
  ];
  if (creator) filters.push({ memcmp: { offset: 8 + 32, bytes: creator.toBase58() } });

  const accounts = await connection.getProgramAccounts(LAUNCH_PROGRAM_ID, { filters });
  return accounts
    .map((a) => decodeCurve(a.pubkey, Buffer.from(a.account.data)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// --- the curve, off chain ------------------------------------------------------------------------

const BPS = 10_000n;

/**
 * The transfer tax on an amount, rounded **up**, which is how Token-2022 itself computes it. Rounding
 * this down instead puts every quote one unit out, and a slippage check that is one unit out fails.
 */
function taxOf(amount: bigint, bps: number): bigint {
  if (bps === 0 || amount === 0n) return 0n;
  return (amount * BigInt(bps) + BPS - 1n) / BPS;
}

/** `reserve_out * amount_in / (reserve_in + amount_in)`, floored, exactly as the program does it. */
function swapOut(reserveOut: bigint, reserveIn: bigint, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  return (reserveOut * amountIn) / (reserveIn + amountIn);
}

export interface BuyQuote {
  /** What actually leaves the buyer, which is less than asked when the curve is nearly full. */
  quoteTaken: bigint;
  fee: bigint;
  /** What the curve sends. The buyer receives this less the token's tax. */
  baseOut: bigint;
  /** What the buyer's account is credited with, tax taken off. */
  baseReceived: bigint;
  graduates: boolean;
}

export function quoteBuy(curve: CurveState, maxQuoteIn: bigint): BuyQuote {
  const room = curve.graduationQuote - curve.quoteRaised;
  let fee = (maxQuoteIn * BigInt(curve.curveFeeBps)) / BPS;
  let net = maxQuoteIn - fee;
  let quoteTaken = maxQuoteIn;
  if (net > room) {
    net = room;
    fee = (room * BigInt(curve.curveFeeBps)) / (BPS - BigInt(curve.curveFeeBps));
    quoteTaken = room + fee;
  }
  const baseOut = swapOut(
    curve.virtualBase - curve.baseSold,
    curve.virtualQuote + curve.quoteRaised,
    net,
  );
  return {
    quoteTaken,
    fee,
    baseOut,
    baseReceived: baseOut - taxOf(baseOut, curve.taxBps),
    graduates: curve.quoteRaised + net >= curve.graduationQuote,
  };
}

export interface SellQuote {
  /** What the seller sends. */
  baseIn: bigint;
  /** What the curve is credited with, the token's tax having been taken on the way in. */
  baseReceived: bigint;
  gross: bigint;
  fee: bigint;
  /** What the seller gets. */
  quoteOut: bigint;
}

export function quoteSell(curve: CurveState, baseIn: bigint): SellQuote {
  const baseReceived = baseIn - taxOf(baseIn, curve.taxBps);
  const gross = swapOut(
    curve.virtualQuote + curve.quoteRaised,
    curve.virtualBase - curve.baseSold,
    baseReceived,
  );
  const fee = (gross * BigInt(curve.curveFeeBps)) / BPS;
  return { baseIn, baseReceived, gross, fee, quoteOut: gross - fee };
}

/** The price one token costs right now, in quote units per whole token. */
export function curvePrice(curve: CurveState, baseDecimals: number): number {
  const reserveBase = curve.virtualBase - curve.baseSold;
  const reserveQuote = curve.virtualQuote + curve.quoteRaised;
  if (reserveBase === 0n) return 0;
  return (Number(reserveQuote) / Number(reserveBase)) * 10 ** baseDecimals;
}

// --- graduation ----------------------------------------------------------------------------------

/** Integer square root, the same bit-by-bit method the program uses. */
export function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let bit = 1n << BigInt((value.toString(2).length - 1) & ~1);
  let root = 0n;
  let rest = value;
  while (bit !== 0n) {
    const candidate = root + bit;
    root >>= 1n;
    if (rest >= candidate) {
      rest -= candidate;
      root += bit;
    }
    bit >>= 2n;
  }
  return root;
}

export interface GraduationParams {
  sqrtPrice: bigint;
  liquidity: bigint;
  /** What the pool will hold once the tax on the way in has been taken. */
  seededBase: bigint;
  /** What leaves the vault, tax included. */
  baseFromVault: bigint;
}

/**
 * The opening price and liquidity for the graduated pool.
 *
 * The price is the curve's closing price measured against what the pool will actually receive: the
 * pool asks for the amount it wants to hold and the token program takes the tax on top, so a pool
 * priced off the gross would ask a fully sold curve for base it does not have.
 *
 * The liquidity is then set by the quote side, floored, so the pool can never pull more quote than
 * the curve raised. The program checks both of these against its own arithmetic and refuses anything
 * more than a percent out.
 */
export function graduationParams(curve: CurveState, availableBase?: bigint): GraduationParams {
  const seededBase = curve.migrationBase - taxOf(curve.migrationBase, curve.taxBps);
  // Full precision on purpose. `sqrt(q / b) * 2^64` is `isqrt((q << 128) / b)`, and taking the root
  // of a smaller shift and shifting the root afterwards throws away most of its bits: on small
  // amounts that is enough to ask the vault for base it does not have.
  const sqrtPrice = isqrt((curve.quoteRaised << 128n) / seededBase);
  // The pool's own quote-side formula is `Δb = L * (√upper - √lower) >> 128`, read backwards from
  // the reserve. Floored, which keeps Δb at or just under what the curve raised.
  let liquidity = (curve.quoteRaised << 128n) / (sqrtPrice - MIN_SQRT_PRICE);
  let deltaA = deltaAmountA(liquidity, sqrtPrice);

  // A last guard for the rounding: the pool asks for the base it wants to hold plus the tax on top,
  // and that total cannot exceed what the vault actually holds. When it would, the liquidity comes
  // down by the same fraction, which costs a hair of the reserve and never the transaction.
  if (availableBase !== undefined) {
    const affordable = availableBase - taxOf(availableBase, curve.taxBps);
    if (deltaA > affordable && deltaA > 0n) {
      liquidity = (liquidity * affordable) / deltaA;
      deltaA = deltaAmountA(liquidity, sqrtPrice);
    }
  }

  const baseFromVault =
    (deltaA * BPS + (BPS - BigInt(curve.taxBps)) - 1n) / (BPS - BigInt(curve.taxBps));
  return { sqrtPrice, liquidity, seededBase: deltaA, baseFromVault };
}

/** What `graduate_into_pool` needs to know about the pool that is already there. */
export interface DammPoolState {
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  liquidity: bigint;
  /** sqrt(B per A) in Q64.64. */
  sqrtPrice: bigint;
  /** When the pool's first trade is allowed, in unix seconds for this config. */
  activationPoint: bigint;
  status: number;
}

/** The pool program's own layout, discriminator included; the same offsets the program reads. */
export function decodeDammPool(data: Uint8Array): DammPoolState {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (at: number) => view.getBigUint64(at, true);
  const u128 = (at: number) => u64(at) | (u64(at + 8) << 64n);
  return {
    tokenAMint: new PublicKey(data.subarray(168, 200)),
    tokenBMint: new PublicKey(data.subarray(200, 232)),
    liquidity: u128(360),
    sqrtPrice: u128(456),
    activationPoint: u64(472),
    status: data[481],
  };
}

/** The pool's trading fee, 1%, as the pool program counts it. Fixed by the config the pool is on. */
const POOL_FEE_NUMERATOR = 10_000_000n;
const POOL_FEE_DENOMINATOR = 1_000_000_000n;
/**
 * How much of the deposit's binding side is held back from the liquidity, so rounding in the pool's
 * favour cannot ask the vault for a unit it does not have. The program wants 99.5% of that side in.
 */
const DEPOSIT_MARGIN_BPS = 10n;

export interface ExistingPoolGraduation {
  /** Whether the curve's base is the pool's first token. */
  baseIsA: boolean;
  /** The price the pool has to end at, in the pool's own orientation. */
  targetSqrtPrice: bigint;
  /** What the program sends into the pool to get it there, in the input token's raw units. */
  swapIn: bigint;
  /** Which way: true when the program sells base, false when it buys base with quote. */
  sellsBase: boolean;
  liquidity: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** An amount grossed up for the token's tax, so that `amount` arrives. */
function withTax(amount: bigint, bps: number): bigint {
  if (bps === 0 || amount === 0n) return amount;
  let gross = ceilDiv(amount * BPS, BPS - BigInt(bps));
  while (gross - taxOf(gross, bps) < amount) gross += 1n;
  return gross;
}

/**
 * The trade and the deposit that move a curve into a pool somebody else opened first.
 *
 * The pool is full range at a flat 1%, collecting its fee in its second token, so the trade that
 * moves its price from where the squatter left it to the curve's closing price is exact arithmetic:
 * raising the price takes `L * Δ√P` of the second token (plus the fee), lowering it takes
 * `L * Δ(1/√P)` of the first. The tax is grossed up on whichever side is the base. The deposit is
 * then as much liquidity as what the curve holds after that trade affords at the new price, less a
 * thousandth for the pool's rounding.
 *
 * A pool already within a fifth of a percent of the price is left untraded: the program accepts a
 * percent either way, and a trade that small would cost more in fees than it corrects.
 */
export function existingPoolGraduation(
  curve: CurveState,
  pool: DammPoolState,
  held: { base: bigint; quote: bigint },
): ExistingPoolGraduation {
  const baseIsA = pool.tokenAMint.equals(curve.mint);
  if (!baseIsA && !pool.tokenBMint.equals(curve.mint)) {
    throw new Error("that pool does not trade this token");
  }
  const close = graduationParams(curve).sqrtPrice;
  // The pool prices its second token in its first; a pool with the quote first holds the inverse.
  const target = baseIsA ? close : ((1n << 128n) - 1n) / close;
  const from = pool.sqrtPrice;
  const L = pool.liquidity;
  const tax = curve.taxBps;
  const feeOn = (x: bigint) => ceilDiv(x * POOL_FEE_NUMERATOR, POOL_FEE_DENOMINATOR);

  let base = held.base;
  let quote = held.quote;
  let swapIn = 0n;
  let sellsBase = false;
  const gap = from > target ? from - target : target - from;
  if (gap * 500n > target && L > 0n) {
    if (from < target) {
      // Raise: pay in the second token, the fee taken off what goes in.
      const net = ceilDiv(L * (target - from), 1n << 128n);
      const gross = ceilDiv(net * POOL_FEE_DENOMINATOR, POOL_FEE_DENOMINATOR - POOL_FEE_NUMERATOR);
      const out = (L * (target - from)) / (from * target);
      if (baseIsA) {
        // Second token is the quote: pay quote, receive base less its tax.
        swapIn = gross;
        quote -= gross;
        base += out - taxOf(out, tax);
      } else {
        // Second token is the base: pay base, taxed on the way in.
        swapIn = withTax(gross, tax);
        sellsBase = true;
        base -= swapIn;
        quote += out;
      }
    } else {
      // Lower: pay in the first token; the fee comes off the second token coming out.
      const net = ceilDiv(L * (from - target), from * target);
      const outGross = (L * (from - target)) >> 128n;
      const out = outGross - feeOn(outGross);
      if (baseIsA) {
        swapIn = withTax(net, tax);
        sellsBase = true;
        base -= swapIn;
        quote += out;
      } else {
        swapIn = net;
        quote -= net;
        base += out - taxOf(out, tax);
      }
    }
  }
  if (base < 0n || quote < 0n) throw new Error("the curve cannot afford to move that pool's price");

  // What each side can deliver into the pool, the base's tax taken on the way.
  const baseArrives = base - taxOf(base, tax);
  const [a, b] = baseIsA ? [baseArrives, quote] : [quote, baseArrives];
  const fromA = (a * target * MAX_SQRT_PRICE) / (MAX_SQRT_PRICE - target);
  const fromB = (b << 128n) / (target - MIN_SQRT_PRICE);
  const liquidity = ((fromA < fromB ? fromA : fromB) * (BPS - DEPOSIT_MARGIN_BPS)) / BPS;

  return { baseIsA, targetSqrtPrice: target, swapIn, sellsBase, liquidity };
}

/** `Δa = L * (√upper - √lower) / (√upper * √lower)`, rounded up the way the pool rounds it. */
function deltaAmountA(liquidity: bigint, sqrtPrice: bigint): bigint {
  const numerator = liquidity * (MAX_SQRT_PRICE - sqrtPrice);
  const denominator = sqrtPrice * MAX_SQRT_PRICE;
  return (numerator + denominator - 1n) / denominator;
}

// --- instructions --------------------------------------------------------------------------------

function meta(pubkey: PublicKey, isSigner = false, isWritable = false): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

export interface ConfigParamsInput {
  feeRecipient: PublicKey;
  withholdAuthority: PublicKey;
  curveFeeBps: number;
  creatorLpShareBps: number;
  taxTiers: [number, number, number, number];
  graduationQuote: bigint;
  saleBase: bigint;
  migrationBase: bigint;
  virtualQuote: bigint;
  virtualBase: bigint;
  tokenDecimals: number;
  paused: boolean;
  dammConfig: PublicKey;
}

function encodeConfigParams(p: ConfigParamsInput): Buffer {
  return concat(
    p.feeRecipient.toBytes(),
    p.withholdAuthority.toBytes(),
    u16le(p.curveFeeBps),
    u16le(p.creatorLpShareBps),
    ...p.taxTiers.map(u16le),
    u64le(p.graduationQuote),
    u64le(p.saleBase),
    u64le(p.migrationBase),
    u64le(p.virtualQuote),
    u64le(p.virtualBase),
    Uint8Array.from([p.tokenDecimals, p.paused ? 1 : 0]),
    p.dammConfig.toBytes(),
  );
}

export function initializeConfigIx(
  authority: PublicKey,
  quoteMint: PublicKey,
  params: ConfigParamsInput,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: [
      meta(configPda(), false, true),
      meta(authority, true, true),
      meta(quoteMint),
      meta(SystemProgram.programId),
    ],
    data: concat(IX.initializeConfig, encodeConfigParams(params)),
  });
}

export function updateConfigIx(
  authority: PublicKey,
  params: ConfigParamsInput,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: [meta(configPda(), false, true), meta(authority, true)],
    data: concat(IX.updateConfig, encodeConfigParams(params)),
  });
}

export interface LaunchInput {
  creator: PublicKey;
  mint: PublicKey;
  quoteMint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  taxBps: number;
}

export function launchIx(input: LaunchInput): TransactionInstruction {
  const authority = vaultAuthorityPda(input.mint);
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: [
      meta(configPda(), false, true),
      meta(curvePda(input.mint), false, true),
      meta(input.mint, true, true),
      meta(authority, false, true),
      meta(baseVault(input.mint), false, true),
      meta(quoteVault(input.mint, input.quoteMint), false, true),
      meta(input.quoteMint),
      meta(input.creator, true, true),
      meta(TOKEN_2022_PROGRAM_ID),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: concat(
      IX.launch,
      stringle(input.name),
      stringle(input.symbol),
      stringle(input.uri),
      u16le(input.taxBps),
    ),
  });
}

interface TradeInput {
  trader: PublicKey;
  mint: PublicKey;
  quoteMint: PublicKey;
  traderBase: PublicKey;
  traderQuote: PublicKey;
}

function tradeKeys(input: TradeInput): AccountMeta[] {
  return [
    meta(configPda()),
    meta(curvePda(input.mint), false, true),
    meta(input.mint),
    meta(input.quoteMint),
    meta(vaultAuthorityPda(input.mint)),
    meta(baseVault(input.mint), false, true),
    meta(quoteVault(input.mint, input.quoteMint), false, true),
    meta(input.traderBase, false, true),
    meta(input.traderQuote, false, true),
    meta(input.trader, true),
    meta(TOKEN_2022_PROGRAM_ID),
    meta(TOKEN_PROGRAM_ID),
  ];
}

export function buyIx(
  input: TradeInput,
  maxQuoteIn: bigint,
  minBaseOut: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: tradeKeys(input),
    data: concat(IX.buy, u64le(maxQuoteIn), u64le(minBaseOut)),
  });
}

export function sellIx(
  input: TradeInput,
  baseIn: bigint,
  minQuoteOut: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: tradeKeys(input),
    data: concat(IX.sell, u64le(baseIn), u64le(minQuoteOut)),
  });
}

export function claimCurveFeesIx(
  mint: PublicKey,
  quoteMint: PublicKey,
  recipientQuoteAccount: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: [
      meta(configPda()),
      meta(curvePda(mint), false, true),
      meta(quoteMint),
      meta(vaultAuthorityPda(mint)),
      meta(quoteVault(mint, quoteMint), false, true),
      meta(recipientQuoteAccount, false, true),
      meta(TOKEN_PROGRAM_ID),
    ],
    data: concat(IX.claimCurveFees),
  });
}

export interface GraduateInput {
  mint: PublicKey;
  quoteMint: PublicKey;
  positionNftMint: PublicKey;
  liquidity: bigint;
  sqrtPrice: bigint;
}

export function graduateIx(input: GraduateInput): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: graduateKeys(input),
    data: concat(IX.graduate, u128le(input.liquidity), u128le(input.sqrtPrice)),
  });
}

/**
 * Graduate into a pool somebody else opened on the curve's graduation address first. The program
 * trades `swapIn` against that pool to bring its price to the curve's, then deposits `liquidity`;
 * `existingPoolGraduation` works both out.
 */
export function graduateIntoPoolIx(
  input: Omit<GraduateInput, "sqrtPrice"> & { swapIn: bigint },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: graduateKeys(input),
    data: concat(IX.graduateIntoPool, u64le(input.swapIn), u128le(input.liquidity)),
  });
}

function graduateKeys(input: { mint: PublicKey; quoteMint: PublicKey; positionNftMint: PublicKey }) {
  const pool = dammPoolPda(input.mint, input.quoteMint);
  return [
    meta(configPda()),
    meta(curvePda(input.mint), false, true),
    meta(vaultAuthorityPda(input.mint), false, true),
    meta(input.mint, false, true),
    meta(input.quoteMint),
    meta(baseVault(input.mint), false, true),
    meta(quoteVault(input.mint, input.quoteMint), false, true),
    meta(DAMM_CONFIG),
    meta(DAMM_POOL_AUTHORITY),
    meta(pool, false, true),
    meta(dammPositionPda(input.positionNftMint), false, true),
    meta(input.positionNftMint, true, true),
    meta(dammPositionNftAccount(input.positionNftMint), false, true),
    meta(dammTokenVault(input.mint, pool), false, true),
    meta(dammTokenVault(input.quoteMint, pool), false, true),
    meta(dammEventAuthority()),
    meta(DAMM_PROGRAM_ID),
    meta(TOKEN_2022_PROGRAM_ID),
    meta(TOKEN_PROGRAM_ID),
    meta(TOKEN_2022_PROGRAM_ID),
    meta(SystemProgram.programId),
  ];
}

export interface ClaimPoolFeesInput {
  mint: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  positionNftMint: PublicKey;
  creatorQuote: PublicKey;
  platformQuote: PublicKey;
  creatorBase: PublicKey;
  platformBase: PublicKey;
}

export function claimPoolFeesIx(input: ClaimPoolFeesInput): TransactionInstruction {
  const pool = dammPoolPda(input.mint, input.quoteMint);
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM_ID,
    keys: [
      meta(configPda()),
      meta(curvePda(input.mint)),
      meta(vaultAuthorityPda(input.mint)),
      meta(input.mint),
      meta(input.quoteMint),
      meta(baseVault(input.mint), false, true),
      meta(quoteVault(input.mint, input.quoteMint), false, true),
      meta(pool, false, true),
      meta(dammPositionPda(input.positionNftMint), false, true),
      meta(input.positionNftMint),
      meta(dammPositionNftAccount(input.positionNftMint)),
      meta(dammTokenVault(input.mint, pool), false, true),
      meta(dammTokenVault(input.quoteMint, pool), false, true),
      meta(DAMM_POOL_AUTHORITY),
      meta(dammEventAuthority()),
      meta(DAMM_PROGRAM_ID),
      meta(input.creator),
      meta(input.creatorQuote, false, true),
      meta(input.platformQuote, false, true),
      meta(input.creatorBase, false, true),
      meta(input.platformBase, false, true),
      meta(TOKEN_2022_PROGRAM_ID),
      meta(TOKEN_PROGRAM_ID),
    ],
    data: concat(IX.claimPoolFees),
  });
}
