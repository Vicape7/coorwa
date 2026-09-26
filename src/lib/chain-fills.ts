/**
 * Fills read straight from Cookie Chain, for pools the trade feed does not index.
 *
 * Candy Shop's feed is where every chart and fill list gets its trades, but it does not pick up
 * every pool: the DAMM pools MomoSwap's keeper opens for a graduated curve can go days without
 * appearing in it, so the pair page of a freshly graduated token showed an empty chart. When that
 * happens the pool's own transactions are read instead. A swap is a transaction in which the pool's
 * vaults gained one side and paid out the other; fee claims and deposits move both the same way or
 * only one, and are skipped.
 *
 * Server-side only.
 */
import { PublicKey } from "@solana/web3.js";
import {
  COOK_DECIMALS,
  COOK_MINT,
  COOK_SOLANA_MINT,
  COOKIE_RPC_URL,
  CURVE_TOKEN_DECIMALS,
  PROGRAM_IDS,
} from "./config";
import { closeAt, fetchRwaCandles, fetchTrades, type Candle, type Trade } from "./candles";
import { fetchCookPriceUsd, fetchMarkets, marketsByMint } from "./cookiescan";
import { cachedStale, fetchJson } from "./http";
import { fetchPools, fetchPoolTrades } from "./launchpad";
import { curvePda, tradedEvents } from "./launch-program";

/** How many of a pool's latest transactions are read. */
const SIGNATURE_LIMIT = 200;
/** Transactions asked for in one batched RPC request. */
const BATCH = 50;

/** Every DAMM pool keeps its vaults under this one authority. */
const DAMM_POOL_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_authority")],
  new PublicKey(PROGRAM_IDS.cookieboxDamm),
)[0].toBase58();

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RpcTransaction {
  blockTime: number | null;
  meta: {
    err: unknown;
    logMessages?: string[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: (string | { pubkey: string })[] };
  };
}

/** A swap as the pool saw it, before it is valued in USD. */
export interface PoolSwap {
  ts: number;
  side: "buy" | "sell";
  /** Whole tokens that left or entered the pool. */
  tokens: number;
  /** Whole COOK that entered or left the pool. */
  cook: number;
  sig: string;
  trader: string;
}

/** Net change of `owner`'s balances of `mint` over the transaction, in whole units. */
function vaultDelta(tx: RpcTransaction, owner: string, mint: string): number {
  const sum = (list: TokenBalance[] | undefined) => {
    let raw = 0n;
    let decimals = 0;
    for (const b of list ?? []) {
      if (b.owner !== owner || b.mint !== mint) continue;
      raw += BigInt(b.uiTokenAmount.amount);
      decimals = b.uiTokenAmount.decimals;
    }
    return { raw, decimals };
  };
  const pre = sum(tx.meta?.preTokenBalances);
  const post = sum(tx.meta?.postTokenBalances);
  const decimals = post.decimals || pre.decimals;
  return Number(post.raw - pre.raw) / 10 ** decimals;
}

/**
 * Read one transaction as a swap between `mint` and COOK through a DAMM pool, or null when it is
 * anything else. A buy takes tokens out of the pool and puts COOK in; a sell does the opposite.
 */
export function swapFromTransaction(
  tx: RpcTransaction,
  mint: string,
  /** Whoever holds the two vaults. A DAMM pool's are all under one authority; a Coorwa curve's are
   *  under its own, which is why this is a parameter rather than the constant it started as. */
  owner: string = DAMM_POOL_AUTHORITY,
): PoolSwap | null {
  if (!tx.meta || tx.meta.err || !tx.blockTime) return null;
  const tokens = vaultDelta(tx, owner, mint);
  const cook = vaultDelta(tx, owner, COOK_MINT);
  if (!tokens || !cook || Math.sign(tokens) === Math.sign(cook)) return null;

  const first = tx.transaction.message.accountKeys[0];
  return {
    ts: tx.blockTime,
    side: tokens < 0 ? "buy" : "sell",
    tokens: Math.abs(tokens),
    cook: Math.abs(cook),
    sig: tx.transaction.signatures[0],
    trader: typeof first === "string" ? first : first.pubkey,
  };
}

interface RpcReply<T> {
  id: number;
  result?: T;
  error?: { message: string };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetchJson<RpcReply<T>>(COOKIE_RPC_URL, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result as T;
}

/** A transaction never changes once confirmed, so a read one is kept for the isolate's life. */
const seen = new Map<string, PoolSwap | null>();

async function readTransactions(sigs: string[], mint: string, owner?: string): Promise<void> {
  if (seen.size > 20_000) seen.clear();
  const missing = sigs.filter((s) => !seen.has(`${mint}:${s}`));
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    const replies = await fetchJson<RpcReply<RpcTransaction | null>[]>(COOKIE_RPC_URL, {
      method: "POST",
      timeoutMs: 20_000,
      body: JSON.stringify(
        chunk.map((sig, id) => ({
          jsonrpc: "2.0",
          id,
          method: "getTransaction",
          params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }],
        })),
      ),
    });
    for (const r of Array.isArray(replies) ? replies : []) {
      const sig = chunk[r.id];
      // An error or a null result may be a node that has not caught up yet; ask again next time.
      if (sig && r.result) seen.set(`${mint}:${sig}`, swapFromTransaction(r.result, mint, owner));
    }
  }
}

/** The latest swaps through one DAMM pool, newest first. */
export async function poolSwaps(pool: string, mint: string): Promise<PoolSwap[]> {
  return cachedStale(`chain-swaps:${pool}:${mint}`, 15_000, async () => {
    const sigs = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [
      pool,
      { limit: SIGNATURE_LIMIT },
    ]);
    const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
    await readTransactions(ok, mint);
    return ok
      .map((s) => seen.get(`${mint}:${s}`))
      .filter((s): s is PoolSwap => !!s)
      .sort((a, b) => b.ts - a.ts);
  });
}

/**
 * The fills of a curve on Coorwa's own launch program, newest first.
 *
 * Nothing indexes these: the program is ours and days old, so the curve's own transactions are the
 * feed. Its two vaults sit under one authority derived from the mint, which is what tells a trade
 * apart from anything else the transaction touched. A buy takes tokens out of the base vault and
 * puts COOK into the quote vault; a sell does the opposite. The tokens counted are what the vault
 * sent, before the transfer tax the mint withholds, which is exactly the price the curve charged.
 */
export async function coorwaFills(mint: string): Promise<Trade[]> {
  const curve = curvePda(new PublicKey(mint)).toBase58();

  const swaps = await cachedStale(`coorwa-fills:${mint}`, 15_000, async () => {
    const sigs = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [
      curve,
      { limit: SIGNATURE_LIMIT },
    ]);
    const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
    await readEvents(ok, mint);
    return ok
      .flatMap((s) => events.get(`${mint}:${s}`) ?? [])
      .sort((a, b) => b.ts - a.ts);
  });

  const cookUsd = await cookValuer();
  return swaps.map((s, i) => ({
    id: i,
    mint,
    ts: s.ts,
    price: s.tokens > 0 ? s.cook / s.tokens : 0,
    price_usd: s.tokens > 0 ? (s.cook / s.tokens) * cookUsd(s.ts) : 0,
    base_amount: s.tokens,
    quote_amount: s.cook,
    side: s.side,
    tx: s.sig,
    maker: s.trader,
    pool: curve,
    venue: "Coorwa curve",
    value_usd: s.cook * cookUsd(s.ts),
  }));
}

/**
 * Trades pulled out of the program's own log lines.
 *
 * Read as events rather than as balance movements because a launch with a buy in it moves the whole
 * supply into the vault in the same transaction, which no balance-based reader can tell from the
 * buy. The event says what the curve actually charged.
 */
const events = new Map<string, PoolSwap[]>();

async function readEvents(sigs: string[], mint: string): Promise<void> {
  if (events.size > 20_000) events.clear();
  const missing = sigs.filter((s) => !events.has(`${mint}:${s}`));
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    const replies = await fetchJson<RpcReply<RpcTransaction | null>[]>(COOKIE_RPC_URL, {
      method: "POST",
      timeoutMs: 20_000,
      body: JSON.stringify(
        chunk.map((sig, id) => ({
          jsonrpc: "2.0",
          id,
          method: "getTransaction",
          params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }],
        })),
      ),
    });
    for (const r of Array.isArray(replies) ? replies : []) {
      const sig = chunk[r.id];
      const tx = r.result;
      if (!sig || !tx) continue;
      if (!tx.meta || tx.meta.err || !tx.blockTime) {
        events.set(`${mint}:${sig}`, []);
        continue;
      }
      const ts = tx.blockTime;
      events.set(
        `${mint}:${sig}`,
        tradedEvents(tx.meta.logMessages)
          .filter((e) => e.mint.toBase58() === mint)
          .map((e) => ({
            ts,
            side: e.isBuy ? ("buy" as const) : ("sell" as const),
            tokens: Number(e.baseAmount) / 10 ** CURVE_TOKEN_DECIMALS,
            cook: Number(e.quoteAmount) / 10 ** COOK_DECIMALS,
            sig,
            trader: e.trader.toBase58(),
          })),
      );
    }
  }
}

/** Values COOK amounts at COOK's USD close in the hour they traded. */
async function cookValuer(): Promise<(ts: number) => number> {
  const [cook, cookNow] = await Promise.all([
    fetchRwaCandles(COOK_SOLANA_MINT, "1h", 1000).catch(() => [] as Candle[]),
    fetchCookPriceUsd(),
  ]);
  const series = [...cook].filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
  return (ts) => closeAt(series, ts, cookNow) ?? 0;
}

/**
 * A curve's fills in the shape the pool feed uses, newest first. Each fill is valued in USD at COOK's
 * price in the hour it traded, so the chart and the list show what it was worth then.
 */
export async function curveFills(pool: string, mint: string): Promise<Trade[]> {
  const [trades, cookUsd] = await Promise.all([fetchPoolTrades(pool), cookValuer()]);
  return trades
    .map((t, i) => ({
      id: i,
      mint,
      ts: t.ts,
      price: t.price,
      price_usd: t.price * cookUsd(t.ts),
      base_amount: t.tokens,
      quote_amount: t.payment,
      side: t.side,
      tx: t.sig,
      maker: t.trader,
      pool,
      venue: "MomoSwap curve",
      value_usd: t.payment * cookUsd(t.ts),
    }))
    .sort((a, b) => b.ts - a.ts);
}

/**
 * Every fill of a token: the trade feed when it knows the token, otherwise the swaps of its DAMM
 * pools read from chain, preceded by its launchpad curve's fills when it graduated from one.
 */
export async function tokenFills(mint: string, limit: number): Promise<Trade[]> {
  const feed = await fetchTrades(mint, limit);
  if (feed.length) return feed;

  const [markets, launchpad, cookUsd] = await Promise.all([
    fetchMarkets(),
    fetchPools("all").catch(() => []),
    cookValuer(),
  ]);
  const damm = (marketsByMint(markets).get(mint) ?? []).filter(
    (m) =>
      m.type.includes("DAMM") &&
      (m.baseToken.mint === COOK_MINT || m.quoteToken.mint === COOK_MINT),
  );
  const curve = launchpad.find((p) => p.tokenMint === mint);

  const [swaps, curveTrades] = await Promise.all([
    Promise.all(
      damm.map(async (m) =>
        (await poolSwaps(m.marketId, mint).catch(() => [])).map((s) => ({ ...s, pool: m })),
      ),
    ),
    curve ? curveFills(curve.pubkey, mint).catch(() => []) : Promise.resolve([]),
  ]);

  const fromChain: Trade[] = swaps.flat().map((s, i) => {
    const price = s.cook / s.tokens;
    const usd = cookUsd(s.ts);
    return {
      id: i,
      mint,
      ts: s.ts,
      price,
      price_usd: price * usd,
      base_amount: s.tokens,
      quote_amount: s.cook,
      side: s.side,
      tx: s.sig,
      maker: s.trader,
      pool: s.pool.marketId,
      venue: s.pool.type,
      value_usd: s.cook * usd,
    };
  });

  // Both sources number their fills from 0, and the list keys rows by id.
  return [...fromChain, ...curveTrades]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((t, id) => ({ ...t, id }));
}
