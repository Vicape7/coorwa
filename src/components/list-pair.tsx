"use client";

/**
 * Buying a benchmark for a token that was not launched here.
 *
 * The terminal used to show every token against all sixteen assets, which is arithmetic rather than
 * a market. Every token now carries one benchmark for nothing, and more are bought a dollar at a
 * time. The dollar is the filter: trivial for somebody who means it, and enough that nobody lists
 * sixteen pairs on a dead token for the sake of it.
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
  free: string;
  listed: string[];
  billable: string[];
  pairs: number;
  usd: number;
  cook: number | null;
  pricePerPairUsd: number;
  cookPriceUsd: number | null;
  /** Whose wallet has to be connected. Only a token's creator may benchmark it. */
  creator: string | null;
  creatorSource: "launch" | "authority" | null;
  error?: string;
}

export function ListPair() {
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

  const free = quote?.free;
  const listed = quote?.listed ?? [];
  const creator = quote?.creator ?? null;
  const mine = creator != null && creator === publicKey?.toBase58();
  // The server decides what is billable, not this side: it knows what has already been paid for.
  const billable = useMemo(() => quote?.billable ?? [], [quote?.billable]);

  const toggle = useCallback((ticker: string) => {
    setDone(null);
    setError(null);
    setWanted((w) => (w.includes(ticker) ? w.filter((t) => t !== ticker) : [...w, ticker]));
  }, []);

  const pay = useCallback(async () => {
    if (!publicKey || !signTransaction || !validMint || !quote?.cook) return;
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
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [publicKey, signTransaction, validMint, quote, connection, billable, mutate]);

  return (
    <div className="card mt-10 p-7">
      <h2 className="title text-primary">Add a benchmark</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">
        Every token is priced against one asset for nothing. Its creator can add more at{" "}
        {usd(quote?.pricePerPairUsd ?? 1)} a pair, paid in COOK straight into the cashback vault -
        not to Coorwa, which cannot touch it - and paid back as cashback to the people who trade
        that pair. Worth doing: once a pair exists, the creator earns a share of the fee on every
        trade against it. Liquidity is still this token&apos;s COOK pool; the benchmark is what the
        price is quoted and charted in.
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

        {validMint && quote && !mine && (
          <Notice tone="note">
            {creator == null ? (
              <>
                Coorwa cannot tell who made this token, so there is nobody to prove a claim against.
                Its mint names no metadata authority.
              </>
            ) : (
              <>
                Only this token&apos;s creator can benchmark it, because they earn the creator share
                of every fee the pair goes on to generate. Connect{" "}
                <span className="num">{shortAddr(creator, 6)}</span>
                {quote.creatorSource === "launch" ? ", the wallet that launched it." : "."}
              </>
            )}
          </Notice>
        )}

        {validMint && (
          <>
            <div>
              <span className="label mb-2 block text-[12px]">Assets</span>
              <div className="flex flex-wrap gap-2">
                {RWA_ASSETS.map((a) => {
                  const isFree = a.ticker === free;
                  const already = listed.includes(a.ticker);
                  const picked = wanted.includes(a.ticker);
                  const owned = isFree || already;
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
                        isFree
                          ? "carried for free by every token"
                          : already
                            ? "already paid for"
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
                {free} is carried for free.
                {listed.length > 0 && ` Already paid for: ${listed.join(", ")}.`}
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
            disabled={busy || billable.length === 0 || !quote?.cook || !mine}
            onClick={pay}
          >
            {busy
              ? "Confirm in your wallet"
              : !mine
                ? "Only the creator can list"
                : billable.length === 0
                  ? "Pick an asset"
                  : `Pay ${usd(quote?.usd ?? 0)} into the vault`}
          </button>
        )}
      </div>
    </div>
  );
}
