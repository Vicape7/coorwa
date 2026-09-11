"use client";

/**
 * LP maker.
 *
 * Reads every pool on Cookie Chain and manages Cookiebox DAMM v2 positions natively - add, claim
 * fees, withdraw - with instructions built against the fork's own program. The wallet signs; Coorwa
 * only builds.
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
import { usd, amount as fmt, shortAddr, rwaRatio } from "@/lib/format";
import { cookieTxUrl, COOKIE_EXPLORER } from "@/lib/config";
import { RWA_ASSETS } from "@/lib/rwa";
import { TokenMark } from "./token-mark";
import { Notice } from "./notice";
import { PillSelect } from "./ui/pill-select";
import { ListPair } from "./list-pair";
import type { PoolRow } from "@/app/api/pools/route";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface PoolsResponse {
  pools: PoolRow[];
  count: number;
  manageableCount: number;
  ticker: string | null;
  rwaPriceUsd: number | null;
  error?: string;
}

export function PoolsView() {
  const [ticker, setTicker] = useState("NVDA");
  const [selected, setSelected] = useState<PoolRow | null>(null);

  const { data } = useSWR<PoolsResponse>(`/api/pools?ticker=${ticker}`, fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  });

  const pools = data?.pools ?? [];

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">LP maker</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Provide the liquidity the pairs run on.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Every share-denominated pair in the terminal is backed by a real Cookie Chain pool. Coorwa
          manages Cookiebox DAMM v2 positions directly - deposit, claim fees, withdraw - and shows
          your position sized in shares, not just dollars.
        </p>
      </div>

      <ListPair />

      <MyPositions />

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <h2 className="title text-primary">All pools</h2>
        {/* Six of the sixteen assets used to sit here as buttons. Same control, all sixteen, no row. */}
        <PillSelect
          id="pools-depth"
          label="Depth in"
          prefix="Depth"
          value={ticker}
          onChange={setTicker}
          options={RWA_ASSETS.map((a) => ({
            value: a.ticker,
            label: a.ticker,
          }))}
          className="ml-auto"
        />
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[14px]">
            <thead>
              <tr>
                <Th>Pool</Th>
                <Th>Venue</Th>
                <Th align="right">Liquidity</Th>
                <Th align="right">in {ticker}</Th>
                <Th align="right">Volume 24h</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {pools.length === 0 &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <td key={j} className="px-5 py-4">
                        <div className="skeleton h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))}
              {pools.slice(0, 60).map((p) => (
                <tr key={p.poolId} className="row-hover">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <TokenMark logo={p.base.logo} symbol={p.base.symbol} size={28} />
                      <span className="text-primary">
                        {p.base.symbol}
                        <span className="text-subtle"> / {p.quote.symbol}</span>
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <span className="pill pill-quiet text-[11px]">{p.venue}</span>
                  </td>
                  <td className="num px-5 py-3 text-right text-primary">{usd(p.liquidityUsd)}</td>
                  <td className="num px-5 py-3 text-right text-muted">
                    {p.liquidityShares == null ? "—" : rwaRatio(p.liquidityShares)}
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
      </div>

      {data && (
        <p className="mt-4 text-[12px] text-subtle">
          {data.count} pools · {data.manageableCount} manageable from Coorwa (Cookiebox DAMM v2).
          Other venues are read-only here and managed in their own app.
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
  symbols: { a: string; b: string };
}

function MyPositions() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const deps = useMemo(() => buildDeps(connection), [connection]);

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

  const wallet = publicKey?.toBase58() ?? null;
  const key = wallet ? `${wallet}|${nonce}` : null;
  const current = key && scan?.key === key ? scan : null;
  const loading = key !== null && current === null;

  useEffect(() => {
    if (!publicKey || !key) return;
    let alive = true;

    (async () => {
      try {
        const found = await findUserPositions(deps, publicKey);
        const loaded: LoadedPosition[] = [];
        for (const p of found) {
          try {
            const ctx = await loadPool(deps, p.pool.toBase58());
            loaded.push({
              position: p,
              ctx,
              value: positionValue(ctx, p),
              symbols: {
                a: shortAddr(ctx.state.tokenAMint.toBase58(), 4),
                b: shortAddr(ctx.state.tokenBMint.toBase58(), 4),
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
  }, [publicKey, deps, key]);

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
      <div className="card mt-10 flex flex-wrap items-center gap-4 p-7">
        <div>
          <div className="text-[15px] text-primary">Your positions</div>
          <p className="mt-1 text-[14px] text-muted">
            Connect to see the DAMM v2 positions this wallet holds and the fees waiting on them.
          </p>
        </div>
        <button className="btn btn-primary ml-auto" onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      </div>
    );
  }

  const positions = current?.positions ?? null;

  return (
    <div className="card mt-10 p-7">
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

      {loading && <div className="skeleton mt-5 h-20 w-full" />}

      {positions !== null && positions.length === 0 && (
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          No DAMM v2 positions in this wallet. Positions are held as Token-2022 NFTs, so Coorwa
          finds them by scanning what you own rather than by keeping its own records.
        </p>
      )}

      {positions && positions.length > 0 && (
        <ul className="mt-5 space-y-3">
          {positions.map((p) => {
            const id = p.position.position.toBase58();
            const hasFees = p.value.feeA > 0 || p.value.feeB > 0;
            return (
              <li key={id} className="panel p-5">
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
                      {fmt(p.value.amountA)} {p.symbols.a} + {fmt(p.value.amountB)} {p.symbols.b}
                    </div>
                    <div className="num mt-1 text-[13px] text-muted">
                      Fees pending: {fmt(p.value.feeA, 8)} / {fmt(p.value.feeB, 8)}
                    </div>
                    {p.position.permanentLockedLiquidity.gtn(0) && (
                      <div className="mt-1 text-[12px] text-subtle">
                        Part of this position is permanently locked and cannot be withdrawn.
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={!hasFees || busy !== null}
                      onClick={() => act(p, "claim")}
                    >
                      {busy === `${id}:claim` ? "Claiming" : "Claim fees"}
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
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(17,26,38,0.45)] p-5"
      onClick={onClose}
    >
      <div
        className="card-float w-full max-w-md p-7"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3">
          <TokenMark logo={pool.base.logo} symbol={pool.base.symbol} size={40} />
          <div className="min-w-0 flex-1">
            <h3 className="title text-primary">
              {pool.base.symbol} / {pool.quote.symbol}
            </h3>
            <p className="text-[13px] text-muted">{pool.venue}</p>
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
