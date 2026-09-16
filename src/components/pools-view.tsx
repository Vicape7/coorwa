"use client";

/**
 * LP maker.
 *
 * Lists the TOKEN/RWA pairs somebody chose, each with the real Cookie Chain pool behind it, and
 * manages Cookiebox DAMM v2 positions natively - add, claim fees, withdraw - with instructions built
 * against the fork's own program. The wallet signs; Coorwa only builds.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  buildDeps,
  loadPool,
  findUserPositions,
  buildAddLiquidity,
  buildRemoveLiquidity,
  buildClaimFees,
  positionValue,
  type PoolContext,
  type UserPosition,
} from "@/lib/liquidity";
import { signSendConfirm, explainError } from "@/lib/tx";
import { usd, amount as fmt, shortAddr, rwaRatio, pct } from "@/lib/format";
import { cookieTxUrl, COOKIE_EXPLORER, COOK_MINT } from "@/lib/config";
import { TokenMark } from "./token-mark";
import { Notice } from "./notice";
import { ListPair } from "./list-pair";
import { LpPayout } from "./lp-payout";
import { isResumable, loadJourney } from "@/lib/journey";
import { lpPayoutSlug } from "@/lib/payout";
import type { PoolRow } from "@/app/api/pools/route";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface PoolsResponse {
  pools: PoolRow[];
  count: number;
  manageableCount: number;
  error?: string;
}

export function PoolsView() {
  const [selected, setSelected] = useState<PoolRow | null>(null);

  const { data, mutate } = useSWR<PoolsResponse>("/api/pools", fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  });

  const pools = data?.pools ?? [];
  const loading = !data;

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">LP maker</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Provide the liquidity the pairs run on.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          A pair is a token priced in a real stock. It exists once somebody adds it, and every trade
          on it goes through the token&apos;s real Cookie Chain pool, which is what you provide.
          Coorwa manages Cookiebox DAMM v2 positions directly - deposit, claim fees, withdraw - and
          can pay your fees out as a stock.
        </p>
      </div>

      <ListPair onListed={() => void mutate()} />

      <MyPositions pools={data ? pools : null} />

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <h2 className="title text-primary">Pairs</h2>
      </div>

      <div className="card mt-4 overflow-hidden">
        {/* A phone gets one card per pair: what it is, its pool, its depth, and the Deposit button. */}
        <ul className="sm:hidden">
          {loading &&
            Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="border-b border-hair px-4 py-4 last:border-0">
                <div className="skeleton h-10 w-full" />
              </li>
            ))}
          {pools.map((p) => (
            <li key={p.slug} className="border-b border-hair px-4 py-3.5 last:border-0">
              <div className="flex items-center gap-3">
                <a href={`/terminal/${p.slug}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <TokenMark logo={p.base.logo} symbol={p.base.symbol} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] text-primary">
                      {p.base.symbol}
                      <span className="text-subtle"> / {p.rwa.ticker}</span>
                    </span>
                    <span className="block truncate text-[12px] text-subtle">
                      {p.base.symbol} / {p.quote.symbol} · {p.venue}
                    </span>
                  </span>
                </a>
                {p.manageable ? (
                  <button className="btn btn-ghost btn-sm shrink-0" onClick={() => setSelected(p)}>
                    Deposit
                  </button>
                ) : (
                  <span className="label shrink-0 text-[12px]">View only</span>
                )}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                <span>
                  Liq <span className="num text-primary">{usd(p.liquidityUsd)}</span>
                </span>
                <span>
                  24h{" "}
                  <span
                    className="num"
                    style={{
                      color:
                        p.change24h == null
                          ? "var(--text-subtle)"
                          : p.change24h >= 0
                            ? "var(--color-up)"
                            : "var(--color-down)",
                    }}
                  >
                    {p.change24h == null ? "—" : pct(p.change24h)}
                  </span>
                </span>
                <span>
                  Vol <span className="num">{p.volume24h ? usd(p.volume24h) : "—"}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>

        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[820px] text-[14px]">
            <thead>
              <tr>
                <Th>Pair</Th>
                <Th>Pool behind it</Th>
                <Th align="right">Liquidity</Th>
                <Th align="right">in shares</Th>
                <Th align="right">vs asset 24h</Th>
                <Th align="right">Volume 24h</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-5 py-4">
                        <div className="skeleton h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))}
              {pools.map((p) => (
                <tr key={p.slug} className="row-hover">
                  <td className="px-5 py-3">
                    <a href={`/terminal/${p.slug}`} className="flex items-center gap-3">
                      <TokenMark logo={p.base.logo} symbol={p.base.symbol} size={28} />
                      <span className="text-primary">
                        {p.base.symbol}
                        <span className="text-subtle"> / {p.rwa.ticker}</span>
                      </span>
                    </a>
                  </td>
                  <td className="px-5 py-3">
                    <span className="text-[13px] text-muted">
                      {p.base.symbol} / {p.quote.symbol}
                    </span>{" "}
                    <span className="pill pill-quiet ml-1 text-[11px]">{p.venue}</span>
                  </td>
                  <td className="num px-5 py-3 text-right text-primary">{usd(p.liquidityUsd)}</td>
                  <td className="num px-5 py-3 text-right text-muted">
                    {p.liquidityShares == null
                      ? "—"
                      : `${rwaRatio(p.liquidityShares)} ${p.rwa.symbol}`}
                  </td>
                  <td
                    className="num px-5 py-3 text-right"
                    style={{
                      color:
                        p.change24h == null
                          ? "var(--text-subtle)"
                          : p.change24h >= 0
                            ? "var(--color-up)"
                            : "var(--color-down)",
                    }}
                  >
                    {p.change24h == null ? "—" : pct(p.change24h)}
                  </td>
                  <td className="num px-5 py-3 text-right text-muted">
                    {p.volume24h ? usd(p.volume24h) : "—"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {p.manageable ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(p)}>
                        Deposit
                      </button>
                    ) : (
                      <span
                        className="label text-[12px]"
                        title="Coorwa builds positions against Cookiebox DAMM v2. Other venues are shown for context but managed in their own app."
                      >
                        View only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data && pools.length === 0 && (
          <p className="p-10 text-center text-[14px] text-muted">
            No pairs yet. Add the first one above: pick a token with a pool and the stock it should be
            priced in.
          </p>
        )}
      </div>

      {data && pools.length > 0 && (
        <p className="mt-4 text-[12px] text-subtle">
          {data.count} {data.count === 1 ? "pair" : "pairs"} · {data.manageableCount} backed by a Cookiebox DAMM v2 pool Coorwa can
          manage. A token with more than one pair shares one pool between them. Other venues are
          read-only here and managed in their own app.
        </p>
      )}

      {selected && <DepositDialog pool={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`label whitespace-nowrap px-5 py-3 text-[12px] font-normal ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

// --- Positions ---------------------------------------------------------------------------------------

interface LoadedPosition {
  position: UserPosition;
  ctx: PoolContext;
  value: ReturnType<typeof positionValue>;
  mints: { a: string; b: string };
}

function MyPositions({ pools }: { pools: PoolRow[] | null }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const deps = useMemo(() => buildDeps(connection), [connection]);

  /** Symbols from the pool list, so a position reads "CHAT / wCOOK" rather than two addresses. */
  const symbolOf = useMemo(() => {
    const known = new Map<string, string>();
    for (const p of pools ?? []) {
      known.set(p.base.mint, p.base.symbol);
      known.set(p.quote.mint, p.quote.symbol);
    }
    known.set(COOK_MINT, known.get(COOK_MINT) ?? "wCOOK");
    return (mint: string) => known.get(mint) ?? shortAddr(mint, 4);
  }, [pools]);

  /** The position whose fees are open as a stock payout, if any. */
  const [payoutFor, setPayoutFor] = useState<string | null>(null);

  /** Bumped by Refresh, and after a write, to force a rescan of the same wallet. */
  const [nonce, setNonce] = useState(0);
  /**
   * The scan result and the request it answers. Deriving "loading" from a key comparison keeps the
   * effect free of synchronous state writes.
   */
  const [scan, setScan] = useState<{
    key: string;
    positions: LoadedPosition[];
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  /**
   * The pools behind Coorwa's listed pairs, as one stable string. Only positions in these pools are
   * shown: fees a wallet earns on some other Cookie Chain pool are not Coorwa's to pay out. Null until
   * the pair list has loaded, so a wallet is never scanned against an empty list.
   */
  const listed = useMemo(
    () => (pools ? [...new Set(pools.map((p) => p.poolId))].sort().join(",") : null),
    [pools],
  );
  /** Each pool's pair asset. A token has one pair, so its pool pays LP fees in that stock only. */
  const tickerOfPool = useMemo(
    () => new Map((pools ?? []).map((p) => [p.poolId, p.rwa.ticker])),
    [pools],
  );

  const wallet = publicKey?.toBase58() ?? null;
  const key = wallet && listed !== null ? `${wallet}|${nonce}|${listed}` : null;
  const rescan = useCallback(() => setNonce((n) => n + 1), []);
  const current = key && scan?.key === key ? scan : null;
  const loading = wallet !== null && current === null;

  useEffect(() => {
    if (!publicKey || !key || listed === null) return;
    let alive = true;
    const pairPools = new Set(listed.split(","));

    (async () => {
      try {
        const found = await findUserPositions(deps, publicKey);
        const loaded: LoadedPosition[] = [];
        for (const p of found.filter((f) => pairPools.has(f.pool.toBase58()))) {
          try {
            const ctx = await loadPool(deps, p.pool.toBase58());
            loaded.push({
              position: p,
              ctx,
              value: positionValue(ctx, p),
              mints: {
                a: ctx.state.tokenAMint.toBase58(),
                b: ctx.state.tokenBMint.toBase58(),
              },
            });
          } catch {
            // A position in a pool we cannot decode is skipped rather than failing the whole list.
          }
        }
        if (alive) setScan({ key, positions: loaded, error: null });
      } catch (e) {
        if (alive) setScan({ key, positions: [], error: explainError(e) });
      }
    })();

    return () => {
      alive = false;
    };
  }, [publicKey, deps, key, listed]);

  const act = useCallback(
    async (p: LoadedPosition, action: "claim" | "withdraw") => {
      if (!publicKey || !signTransaction) return;
      setBusy(`${p.position.position.toBase58()}:${action}`);
      setResult(null);
      try {
        const tx =
          action === "claim"
            ? await buildClaimFees({
                ctx: p.ctx,
                owner: publicKey,
                position: p.position,
              })
            : await buildRemoveLiquidity({
                ctx: p.ctx,
                owner: publicKey,
                position: p.position,
                bps: 10_000,
              });
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;
        const sent = await signSendConfirm(connection, tx, signTransaction);
        setResult(sent.signature);
        setNonce((n) => n + 1);
      } catch (e) {
        setScan((s) => (s ? { ...s, error: explainError(e) } : s));
      } finally {
        setBusy(null);
      }
    },
    [publicKey, signTransaction, connection],
  );

  if (!publicKey) {
    return (
      <div className="card mt-10 flex flex-wrap items-center gap-4 p-5 sm:p-7">
        <div>
          <div className="text-[15px] text-primary">Your positions</div>
          <p className="mt-1 text-[14px] text-muted">
            Connect to see this wallet&apos;s positions in the pools behind Coorwa&apos;s pairs and the
            fees waiting on them.
          </p>
        </div>
        <button className="btn btn-primary ml-auto" onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      </div>
    );
  }

  // A rescan keeps the last list on screen, so a payout panel open under a position is not unmounted
  // (and its final state lost) by the refresh its own completion asks for.
  const previous = scan && wallet && scan.key.startsWith(`${wallet}|`) ? scan : null;
  const positions = current?.positions ?? previous?.positions ?? null;

  return (
    <div className="card mt-10 p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="title text-primary">Your positions</h2>
        <button
          className="btn btn-quiet btn-sm ml-auto"
          onClick={() => setNonce((n) => n + 1)}
          disabled={loading}
        >
          {loading ? "Scanning" : "Refresh"}
        </button>
      </div>

      {current?.error && (
        <div className="mt-4">
          <Notice tone="down">{current.error}</Notice>
        </div>
      )}
      {result && (
        <div className="mt-4">
          <Notice tone="up">
            Done.{" "}
            <a
              href={cookieTxUrl(result)}
              target="_blank"
              rel="noreferrer"
              className="num underline underline-offset-4"
            >
              {shortAddr(result, 6)}
            </a>
          </Notice>
        </div>
      )}

      {loading && positions === null && <div className="skeleton mt-5 h-20 w-full" />}

      {positions !== null && positions.length === 0 && (
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          No positions in the pools behind Coorwa&apos;s pairs. Positions in other Cookie Chain pools
          are not shown here, because their fees are not Coorwa&apos;s to pay out.
        </p>
      )}

      {positions && positions.length > 0 && (
        <ul className="mt-5 space-y-3">
          {positions.map((p) => {
            const id = p.position.position.toBase58();
            const hasFees = p.value.feeA > 0 || p.value.feeB > 0;
            const symbols = { a: symbolOf(p.mints.a), b: symbolOf(p.mints.b) };
            return (
              <li key={id} className="panel p-4 sm:p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <a
                      href={`${COOKIE_EXPLORER}/account/${p.position.pool.toBase58()}`}
                      target="_blank"
                      rel="noreferrer"
                      className="num text-[13px] text-muted underline underline-offset-4"
                    >
                      {shortAddr(p.position.pool.toBase58(), 6)}
                    </a>
                    <div className="num mt-2 text-[15px] text-primary">
                      {fmt(p.value.amountA)} {symbols.a} + {fmt(p.value.amountB)} {symbols.b}
                    </div>
                    <div className="num mt-1 break-words text-[13px] text-muted">
                      Fees pending: {fmt(p.value.feeA, 8)} {symbols.a} / {fmt(p.value.feeB, 8)}{" "}
                      {symbols.b}
                    </div>
                    {p.position.permanentLockedLiquidity.gtn(0) && (
                      <div className="mt-1 text-[12px] text-subtle">
                        Part of this position is permanently locked and cannot be withdrawn.
                      </div>
                    )}
                  </div>

                  {/*
                    Three buttons never fit one phone row, and a row that cannot wrap widened the
                    page. On a phone the stock payout takes the full width and the other two share
                    the row under it; from sm they sit side by side as before.
                  */}
                  <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0">
                    {/* The stock payout comes first: settling into a real asset is what Coorwa is for. */}
                    <button
                      className="btn btn-primary btn-sm col-span-2"
                      disabled={(!hasFees && payoutFor !== id) || busy !== null}
                      onClick={() => setPayoutFor((open) => (open === id ? null : id))}
                      aria-expanded={payoutFor === id}
                    >
                      {payoutFor === id ? "Hide" : "Take fees as stock"}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={!hasFees || busy !== null}
                      onClick={() => act(p, "claim")}
                    >
                      {busy === `${id}:claim` ? "Claiming" : "Claim as tokens"}
                    </button>
                    <button
                      className="btn btn-quiet btn-sm"
                      disabled={busy !== null || p.position.unlockedLiquidity.lten(0)}
                      onClick={() => act(p, "withdraw")}
                    >
                      {busy === `${id}:withdraw` ? "Withdrawing" : "Withdraw all"}
                    </button>
                  </div>
                </div>

                {/* A payout that stopped on an earlier visit shows itself without being asked. */}
                {(payoutFor === id || isResumable(loadJourney(wallet!, lpPayoutSlug(id)))) &&
                  tickerOfPool.has(p.position.pool.toBase58()) && (
                    <LpPayout
                      ticker={tickerOfPool.get(p.position.pool.toBase58())!}
                      p={{
                        pool: p.position.pool.toBase58(),
                        position: id,
                        positionNftAccount: p.position.positionNftAccount.toBase58(),
                        a: {
                          mint: p.mints.a,
                          symbol: symbols.a,
                          decimals: p.ctx.aDecimals,
                          feeRaw: p.value.feeARaw,
                        },
                        b: {
                          mint: p.mints.b,
                          symbol: symbols.b,
                          decimals: p.ctx.bDecimals,
                          feeRaw: p.value.feeBRaw,
                        },
                      }}
                      onSettled={rescan}
                    />
                  )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// --- Deposit ------------------------------------------------------------------------------------------

function DepositDialog({ pool, onClose }: { pool: PoolRow; onClose: () => void }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const deps = useMemo(() => buildDeps(connection), [connection]);

  const [loaded, setLoaded] = useState<{
    key: string;
    ctx: PoolContext | null;
    error: string | null;
  } | null>(null);
  const [side, setSide] = useState<"a" | "b">("b");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const current = loaded?.key === pool.poolId ? loaded : null;
  const ctx = current?.ctx ?? null;
  const loading = current === null;

  useEffect(() => {
    let alive = true;
    loadPool(deps, pool.poolId)
      .then((c) => alive && setLoaded({ key: pool.poolId, ctx: c, error: null }))
      .catch((e) => alive && setLoaded({ key: pool.poolId, ctx: null, error: explainError(e) }));
    return () => {
      alive = false;
    };
  }, [deps, pool.poolId]);

  const symbols = useMemo(() => {
    if (!ctx) return { a: "A", b: "B" };
    const isBaseA = ctx.state.tokenAMint.toBase58() === pool.base.mint;
    return {
      a: isBaseA ? pool.base.symbol : pool.quote.symbol,
      b: isBaseA ? pool.quote.symbol : pool.base.symbol,
    };
  }, [ctx, pool]);

  const deposit = useCallback(async () => {
    if (!publicKey || !signTransaction || !ctx) return;
    const value = Number(input);
    if (!(value > 0)) return;

    setBusy(true);
    setTxError(null);
    setDone(null);
    try {
      const { transaction, positionNft } = await buildAddLiquidity({
        ctx,
        owner: publicKey,
        amountA: side === "a" ? value : null,
        amountB: side === "b" ? value : null,
        slippageBps: 100,
      });

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;
      // The position NFT mint is a signer: the position PDA is derived from it.
      transaction.partialSign(positionNft);

      const sent = await signSendConfirm(connection, transaction, signTransaction);
      setDone(sent.signature);
      setInput("");
    } catch (e) {
      setTxError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [publicKey, signTransaction, ctx, input, side, connection]);

  const error = txError ?? current?.error ?? null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-5">
      {/* The scrim is a sibling, not the parent: a blurred parent would leave the dialog's own
          glass nothing to blur. */}
      <div aria-hidden className="glass-scrim absolute inset-0" onClick={onClose} />
      <div
        className="glass-dialog relative max-h-[calc(100dvh-40px)] w-full max-w-md overflow-y-auto p-5 sm:p-7"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3">
          <TokenMark logo={pool.base.logo} symbol={pool.base.symbol} size={40} />
          <div className="min-w-0 flex-1">
            <h3 className="title text-primary">
              {pool.base.symbol} / {pool.rwa.ticker}
            </h3>
            <p className="text-[13px] text-muted">
              Deposits into the {pool.base.symbol} / {pool.quote.symbol} pool on {pool.venue}
            </p>
          </div>
          <button className="btn btn-quiet btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {loading && <div className="skeleton mt-6 h-24 w-full" />}

        {ctx && (
          <>
            <div className="segmented mt-6 w-full">
              <button onClick={() => setSide("a")} data-active={side === "a"} className="flex-1">
                Deposit {symbols.a}
              </button>
              <button onClick={() => setSide("b")} data-active={side === "b"} className="flex-1">
                Deposit {symbols.b}
              </button>
            </div>

            <div className="panel mt-3 p-4">
              <div className="label mb-2 text-[12px]">Amount</div>
              <div className="flex items-center gap-3">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  placeholder="0"
                  className="num w-full bg-transparent text-[26px] text-primary outline-none placeholder:text-[color:var(--text-subtle)]"
                />
                <span className="pill shrink-0 bg-[var(--surface)] text-primary">
                  {side === "a" ? symbols.a : symbols.b}
                </span>
              </div>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-subtle">
              A deposit takes both sides at the pool&apos;s current ratio; the other side is derived
              from what you enter here. The position is minted as a Token-2022 NFT you hold - Coorwa
              keeps no record of it.
            </p>
          </>
        )}

        {error && (
          <div className="mt-4">
            <Notice tone="down">{error}</Notice>
          </div>
        )}
        {done && (
          <div className="mt-4">
            <Notice tone="up">
              Deposited.{" "}
              <a
                href={cookieTxUrl(done)}
                target="_blank"
                rel="noreferrer"
                className="num underline underline-offset-4"
              >
                {shortAddr(done, 6)}
              </a>
            </Notice>
          </div>
        )}

        {!publicKey ? (
          <button className="btn btn-primary mt-5 w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary mt-5 w-full"
            disabled={!ctx || busy || !(Number(input) > 0)}
            onClick={deposit}
          >
            {busy ? "Confirm in your wallet" : "Add liquidity"}
          </button>
        )}
      </div>
    </div>
  );
}
