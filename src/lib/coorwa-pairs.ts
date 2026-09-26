/**
 * Pairs whose token was launched on Coorwa's own curve, before and after it graduates.
 *
 * The launchpad's curves have `curve-pairs.ts`; this is the same job for the program Coorwa runs
 * itself. Everything comes off the chain: the curve account gives the reserves and so the price in
 * COOK, COOK's own market turns that into dollars, and the stock's price divides it into the ratio
 * the pair is quoted in. Once the curve has graduated the price is the pool's instead, read from the
 * pool account the program opened, so a Coorwa token keeps this page and this panel for its whole
 * life whether or not anything else ever indexes its pool. The name and picture come from the metadata Coorwa hosts for the mint,
 * read straight out of the store rather than over the network.
 *
 * Server-side only. Its numbers cross to the page as strings, because a curve counts in u64s.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { COOKIE_RPC_URL, COOK_DECIMALS, COOK_MINT, CURVE_TOKEN_DECIMALS } from "./config";
import { fetchCookPriceUsd } from "./cookiescan";
import { fetchRwaPrices } from "./jupiter";
import { benchmarks } from "./launches";
import { listedByMint } from "./listings";
import { rwaByTicker } from "./rwa";
import {
  dammPoolPda,
  dammTokenVault,
  decodeDammPool,
  fetchCurve,
  poolPriceCook,
  type CurveState,
} from "./launch-program";
import { metadataKey } from "./launch-metadata";
import { metadataStore } from "./launch-store";
import { curveSlug } from "./pair-slug";

export interface CoorwaCurve {
  address: string;
  creator: string;
  taxBps: number;
  curveFeeBps: number;
  creatorLpShareBps: number;
  state: "live" | "graduated" | "pooled";
  /** Raw u64s, as strings: the page turns them back into bigints to quote a trade. */
  virtualBase: string;
  virtualQuote: string;
  baseSold: string;
  quoteRaised: string;
  graduationQuote: string;
  saleBase: string;
  migrationBase: string;
  feesQuote: string;
  /** How far the raise has come, 0 to 1. */
  progress: number;
  /** Unix seconds the curve opened. */
  startedAt: number;
}

export interface CoorwaPair {
  slug: string;
  base: { mint: string; symbol: string; name: string; logo: string | null; decimals: number };
  quote: {
    ticker: string;
    symbol: string;
    mint: string;
    name: string;
    priceUsd: number;
    change24h: number | null;
  };
  curve: CoorwaCurve;
  cookPriceUsd: number | null;
  /** The token's spot price on the curve, in USD. Null until COOK has a price. */
  priceUsd: number | null;
  /** How many stock shares one token is worth. */
  price: number | null;
  /** How many tokens buy one whole share. */
  inverse: number | null;
  raisedUsd: number | null;
  /** The graduated pool, once there is one. Its price is the token's price from then on. */
  pool: CoorwaPool | null;
}

export interface CoorwaPool {
  address: string;
  /** Whether the token is the pool's first mint; a pool somebody else opened may list COOK first. */
  baseIsA: boolean;
  /** Raw u128s, as strings, for the panel's quotes. */
  sqrtPrice: string;
  liquidity: string;
  /** COOK in the pool, whole units. */
  cookHeld: number;
  /** Both sides at the pool's own price, which for a full-range pool is twice the COOK side. */
  liquidityUsd: number | null;
}

/** The pool a graduated curve opened, read and priced. Null when there is none. */
async function graduatedPool(
  connection: Connection,
  mint: PublicKey,
  cookPriceUsd: number | null,
): Promise<CoorwaPool | null> {
  const cook = new PublicKey(COOK_MINT);
  const address = dammPoolPda(mint, cook);
  const [info, held] = await Promise.all([
    connection.getAccountInfo(address, "confirmed"),
    connection.getTokenAccountBalance(dammTokenVault(cook, address), "confirmed").catch(() => null),
  ]);
  if (!info) return null;
  const state = decodeDammPool(info.data);
  const cookHeld = held ? Number(held.value.amount) / 10 ** COOK_DECIMALS : 0;
  return {
    address: address.toBase58(),
    baseIsA: state.tokenAMint.equals(mint),
    sqrtPrice: state.sqrtPrice.toString(),
    liquidity: state.liquidity.toString(),
    cookHeld,
    liquidityUsd: cookPriceUsd ? 2 * cookHeld * cookPriceUsd : null,
  };
}

export function serialiseCurve(curve: CurveState): CoorwaCurve {
  return {
    address: curve.address.toBase58(),
    creator: curve.creator.toBase58(),
    taxBps: curve.taxBps,
    curveFeeBps: curve.curveFeeBps,
    creatorLpShareBps: curve.creatorLpShareBps,
    state: curve.state,
    virtualBase: curve.virtualBase.toString(),
    virtualQuote: curve.virtualQuote.toString(),
    baseSold: curve.baseSold.toString(),
    quoteRaised: curve.quoteRaised.toString(),
    graduationQuote: curve.graduationQuote.toString(),
    saleBase: curve.saleBase.toString(),
    migrationBase: curve.migrationBase.toString(),
    feesQuote: curve.feesQuote.toString(),
    startedAt: curve.createdAt,
    progress:
      curve.graduationQuote > 0n
        ? Math.min(1, Number((curve.quoteRaised * 10_000n) / curve.graduationQuote) / 10_000)
        : 0,
  };
}

/** COOK per whole token at the curve's current reserves. */
export function coorwaPriceCook(curve: CoorwaCurve): number {
  const base = BigInt(curve.virtualBase) - BigInt(curve.baseSold);
  const quote = BigInt(curve.virtualQuote) + BigInt(curve.quoteRaised);
  if (base <= 0n) return 0;
  return (
    (Number(quote) / Number(base)) * 10 ** (CURVE_TOKEN_DECIMALS - COOK_DECIMALS)
  );
}

/** The name and picture a launch stored, or nulls when its metadata never reached the store. */
async function hostedMetadata(
  mint: string,
): Promise<{ name: string | null; symbol: string | null; image: string | null }> {
  const empty = { name: null, symbol: null, image: null };
  const store = metadataStore();
  if (!store) return empty;
  try {
    const object = await store.get(metadataKey(mint));
    if (!object) return empty;
    const doc = JSON.parse(new TextDecoder().decode(object.body));
    return {
      name: typeof doc.name === "string" ? doc.name : null,
      symbol: typeof doc.symbol === "string" ? doc.symbol : null,
      // Served from this app whatever the document says, so a token launched against a development
      // server shows its picture too.
      image:
        typeof doc.image === "string"
          ? doc.image.includes(`/t/${mint}/image`)
            ? `/t/${mint}/image`
            : doc.image
          : null,
    };
  } catch {
    return empty;
  }
}

/** Resolve `<mint>-<ticker>` to a Coorwa curve pair, when that mint was launched in that asset. */
export async function findCoorwaPair(slug: string): Promise<CoorwaPair | null> {
  const idx = slug.lastIndexOf("-");
  if (idx < 1) return null;
  const asset = rwaByTicker(slug.slice(idx + 1));
  if (!asset) return null;
  const mint = slug.slice(0, idx);

  const connection = new Connection(COOKIE_RPC_URL, "confirmed");
  let curve: CurveState | null;
  try {
    curve = await fetchCurve(connection, new PublicKey(mint));
  } catch {
    return null;
  }
  if (!curve) return null;

  const [pinned, listed] = await Promise.all([benchmarks(), listedByMint()]);
  if ((pinned.get(mint) ?? listed.get(mint)) !== asset.ticker) return null;

  const [cookPriceUsd, prices, meta] = await Promise.all([
    fetchCookPriceUsd(),
    fetchRwaPrices(),
    hostedMetadata(mint),
  ]);
  const stock = prices[asset.ticker];
  if (!stock || !(stock.priceUsd > 0)) return null;

  const serialised = serialiseCurve(curve);
  const pool =
    curve.state === "pooled"
      ? await graduatedPool(connection, curve.mint, cookPriceUsd).catch(() => null)
      : null;
  const priceCook = pool
    ? poolPriceCook(BigInt(pool.sqrtPrice), pool.baseIsA, CURVE_TOKEN_DECIMALS)
    : coorwaPriceCook(serialised);
  const priceUsd = cookPriceUsd && priceCook > 0 ? priceCook * cookPriceUsd : null;
  const raisedCook = Number(curve.quoteRaised) / 10 ** COOK_DECIMALS;

  return {
    slug: curveSlug(mint, asset.ticker),
    base: {
      mint,
      symbol: meta.symbol ?? mint.slice(0, 4),
      name: meta.name ?? mint.slice(0, 8),
      logo: meta.image,
      decimals: CURVE_TOKEN_DECIMALS,
    },
    quote: {
      ticker: asset.ticker,
      symbol: asset.symbol,
      mint: asset.mint,
      name: asset.name,
      priceUsd: stock.priceUsd,
      change24h: stock.change24h,
    },
    curve: serialised,
    cookPriceUsd,
    priceUsd,
    price: priceUsd ? priceUsd / stock.priceUsd : null,
    inverse: priceUsd ? stock.priceUsd / priceUsd : null,
    raisedUsd: cookPriceUsd ? raisedCook * cookPriceUsd : null,
    pool,
  };
}

/** Every Coorwa curve, graduated or not, as pairs, for the terminal's own list. */
export async function coorwaPairs(): Promise<CoorwaPair[]> {
  const [pinned, listed] = await Promise.all([benchmarks(), listedByMint()]);
  const { fetchCurves } = await import("./launch-program");
  const curves = await fetchCurves(new Connection(COOKIE_RPC_URL, "confirmed")).catch(() => []);

  const out: CoorwaPair[] = [];
  for (const curve of curves) {
    const mint = curve.mint.toBase58();
    const ticker = pinned.get(mint) ?? listed.get(mint);
    if (!ticker) continue;
    const pair = await findCoorwaPair(curveSlug(mint, ticker));
    if (pair) out.push(pair);
  }
  return out;
}
