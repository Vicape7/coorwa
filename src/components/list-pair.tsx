"use client";

/**
 * Buying a TOKEN/RWA pair.
 *
 * A pair exists only because somebody chose it. A token launched here starts with the benchmark its
 * creator picked; any other token starts with none and is not in the terminal. Anyone can buy a
 * token a pair, a dollar at a time. The dollar is the filter: trivial for somebody who means it, and
 * enough that nobody lists sixteen pairs on a dead token for the sake of it.
 *
 * Where the money goes is the point. The payment is a plain `fund` call on the cashback vault,
 * which the programme lets anyone make, so a listing fee lands in the same account the rebate is
 * paid out of and Coorwa never holds it. What backs the pair is still the token's real COOK pool on
 * this page - a TOKEN/xStock pool cannot exist on Cookie Chain, and Coorwa does not pretend one
 * does. The benchmark is what the price is quoted and charted in.
 */
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { COOK_DECIMALS, VAULT_MINT, cookieTxUrl } from "@/lib/config";
import { RWA_ASSETS } from "@/lib/rwa";
import { amount, shortAddr, usd } from "@/lib/format";
import { signSendConfirm, explainError } from "@/lib/tx";
import { fundTransaction } from "@/lib/vault";
import { Notice } from "./notice";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Quote {
  mint: string;
  /** The benchmark picked at launch, when the token was launched here. */
  pin: string | null;
  carried: string[];
  billable: string[];
  tradeable: boolean;
  liquidityUsd: number;
  pairs: number;
  usd: number;
  cook: number | null;
  pricePerPairUsd: number;
  cookPriceUsd: number | null;
  /** Who earns the creator share of the pair's fees. Named, not a gate: anyone can pay. */
  creator: string | null;
  creatorSource: "launch" | "authority" | null;
  error?: string;
}

export function ListPair({ onListed }: { onListed?: () => void }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [mint, setMint] = useState("");
  const [wanted, setWanted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ signature: string; listed: string[]; note?: string } | null>(
    null,
  );

  const validMint = useMemo(() => {
    if (mint.trim().length < 32) return null;
    try {
      return new PublicKey(mint.trim()).toBase58();
    } catch {
      return null;
    }
  }, [mint]);

  const { data: quote, mutate } = useSWR<Quote>(
    validMint ? `/api/listings?mint=${validMint}&tickers=${wanted.join(",")}` : null,
    fetcher,
  );

  const carried = quote?.carried ?? [];
  const creator = quote?.creator ?? null;
  const tradeable = quote?.tradeable ?? false;
  // The server decides what is billable, not this side: it knows what has already been paid for.
  const billable = useMemo(() => quote?.billable ?? [], [quote?.billable]);

  const toggle = useCallback((ticker: string) => {
    setDone(null);
    setError(null);
    setWanted((w) => (w.includes(ticker) ? w.filter((t) => t !== ticker) : [...w, ticker]));
  }, []);

  const pay = useCallback(async () => {
    if (!publicKey || !signTransaction || !validMint || !quote?.cook || !quote.tradeable) return;
    setBusy(true);
    setError(null);
    setDone(null);

    try {
      const raw = BigInt(Math.ceil(quote.cook * 10 ** COOK_DECIMALS));
      const tx = await fundTransaction(connection, publicKey, new PublicKey(VAULT_MINT), raw);
      const sent = await signSendConfirm(connection, tx, signTransaction);

      // The pairs are recorded against the payment, not against this request: the server reads what
      // actually reached the vault and buys as many as that covers.
      const res = await fetch("/api/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signature: sent.signature,
          mint: validMint,
          payer: publicKey.toBase58(),
          tickers: billable,
        }),
      }).then((r) => r.json());

      if (res.error) throw new Error(res.hint ? `${res.error} - ${res.hint}` : res.error);

      setDone({ signature: sent.signature, listed: res.listed ?? [], note: res.note });
      setWanted([]);
      mutate();
      onListed?.();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [publicKey, signTransaction, validMint, quote, connection, billable, mutate, onListed]);

  return (
    <div className="card mt-10 p-7">
      <h2 className="title text-primary">Add a pair</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">
        A token is only in the terminal once somebody gives it a pair. Anyone can, for{" "}
        {usd(quote?.pricePerPairUsd ?? 1)} a pair, paid in COOK straight into the cashback vault -
        not to Coorwa, which cannot touch it. That dollar goes back to the people who trade the
        pair, and every fee the pair earns after that goes to its traders and to the token&apos;s
        creator. Liquidity is still the token&apos;s COOK pool; the asset is what the price is quoted
        and charted in.
      </p>

      <div className="mt-6 space-y-4">
        <label className="block">
          <span className="label mb-1.5 block text-[12px]">Token mint</span>
          <input
            value={mint}
            onChange={(e) => {
              setMint(e.target.value.trim());
              setDone(null);
            }}
            placeholder="The mint address of the token to price"
            className="field num w-full"
          />
        </label>

        {mint.length > 0 && !validMint && (
          <Notice tone="note">That does not look like a mint address.</Notice>
        )}

        {validMint && quote && !quote.error && !tradeable && (
          <Notice tone="note">
            This token has no pool on Cookie Chain with real liquidity, so a pair on it could not be
            traded or priced. Nothing can be bought for it until it has one.
          </Notice>
        )}

        {validMint && quote && tradeable && (
          <>
            <div>
              <span className="label mb-2 block text-[12px]">Assets</span>
              <div className="flex flex-wrap gap-2">
                {RWA_ASSETS.map((a) => {
                  const owned = carried.includes(a.ticker);
                  const picked = wanted.includes(a.ticker);
                  return (
                    <button
                      key={a.ticker}
                      onClick={() => !owned && toggle(a.ticker)}
                      disabled={owned}
                      // Inline, because `.pill-quiet` is a real class and would win the cascade.
                      style={
                        picked && !owned
                          ? { background: "var(--accent)", color: "var(--accent-contrast)" }
                          : undefined
                      }
                      className="pill num pill-quiet disabled:opacity-45"
                      title={
                        a.ticker === quote.pin
                          ? "picked by its creator at launch"
                          : owned
                            ? "already listed"
                            : a.name
                      }
                    >
                      {a.ticker}
                      {owned ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[12px] text-subtle">
                {carried.length === 0
                  ? "No pairs yet."
                  : `Already listed: ${carried.join(", ")}${quote.pin ? ` (${quote.pin} picked at launch)` : ""}.`}
                {creator && (
                  <>
                    {" "}
                    The creator share goes to <span className="num">{shortAddr(creator, 5)}</span>.
                  </>
                )}
              </p>
            </div>

            {billable.length > 0 && (
              <div className="panel flex flex-wrap items-baseline justify-between gap-3 px-4 py-3">
                <span className="text-[13px] text-muted">
                  {billable.length} {billable.length === 1 ? "pair" : "pairs"}:{" "}
                  <span className="num text-primary">{billable.join(", ")}</span>
                </span>
                <span className="num text-[15px] text-primary">
                  {usd(quote?.usd ?? 0)}
                  {quote?.cook != null && (
                    <span className="ml-2 text-[12px] text-muted">
                      about {amount(quote.cook)} COOK
                    </span>
                  )}
                </span>
              </div>
            )}
          </>
        )}

        {error && <Notice tone="down">{error}</Notice>}

        {done && (
          <Notice tone={done.listed.length > 0 ? "up" : "note"}>
            {done.listed.length > 0 ? `Listed ${done.listed.join(", ")}. ` : "Nothing was listed. "}
            {done.note ? `${done.note}. ` : ""}
            <a
              href={cookieTxUrl(done.signature)}
              target="_blank"
              rel="noreferrer"
              className="num underline underline-offset-4"
            >
              {shortAddr(done.signature, 6)}
            </a>
          </Notice>
        )}

        {!publicKey ? (
          <button className="btn btn-primary" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy || billable.length === 0 || !quote?.cook || !tradeable}
            onClick={pay}
          >
            {busy
              ? "Confirm in your wallet"
              : billable.length === 0
                ? "Pick an asset"
                : `Pay ${usd(quote?.usd ?? 0)} into the vault`}
          </button>
        )}
      </div>
    </div>
  );
}
