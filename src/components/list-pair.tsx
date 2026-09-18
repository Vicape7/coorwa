"use client";

/**
 * Setting a token's pair.
 *
 * A token has one pair, and the pair is the asset its holders are paid in. A token launched here got
 * it at launch. Any other token has none, and is not in the terminal, until its creator picks one and
 * pays a dollar for it. Nobody else can, and it cannot be changed afterwards, because holders buy the
 * token expecting to be paid in that asset.
 *
 * The payment is a plain COOK transfer to the operator, and the dollar joins the token's holder
 * rewards. What backs the pair is still the token's real COOK pool: a TOKEN/xStock pool cannot exist
 * on Cookie Chain, and Coorwa does not pretend one does.
 */
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { COOK_DECIMALS, cookieTxUrl } from "@/lib/config";
import { RWA_ASSETS } from "@/lib/rwa";
import { amount, shortAddr, usd } from "@/lib/format";
import { signSendConfirm, explainError } from "@/lib/tx";
import {
  clearUnrecorded,
  postRecord,
  saveUnrecorded,
  useUnrecorded,
} from "@/lib/unrecorded";
import { Notice } from "./notice";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Quote {
  mint: string;
  /** The benchmark picked at launch, when the token was launched here. */
  pin: string | null;
  /** The token's one pair, however it was set. */
  pair: string | null;
  tradeable: boolean;
  liquidityUsd: number;
  usd: number;
  cook: number | null;
  cookPriceUsd: number | null;
  /** The only wallet that may set the pair. */
  creator: string | null;
  creatorSource: "launch" | "authority" | null;
  operator: string | null;
  error?: string;
}

/** What POST /api/listings takes: the payment and the pair it was for. */
interface PairReport {
  signature: string;
  mint: string;
  payer: string;
  ticker: string;
}

export function ListPair({ onListed }: { onListed?: () => void }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  // Null until the field is typed in, so a payment left waiting can fill it (below).
  const [typed, setTyped] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ signature: string; pair: string } | null>(null);

  // Payments that landed but were not recorded. While one waits for a token, the page offers to
  // report it again and does not offer to pay, so nobody pays twice for one pair. Opened again
  // after the failure, the field starts on the token whose payment is waiting.
  const waiting = useUnrecorded<PairReport>("pair");
  const payer = publicKey?.toBase58() ?? null;
  const mint =
    typed ?? Object.values(waiting).find((u) => u.body.payer === payer)?.body.mint ?? "";

  const validMint = useMemo(() => {
    if (mint.trim().length < 32) return null;
    try {
      return new PublicKey(mint.trim()).toBase58();
    } catch {
      return null;
    }
  }, [mint]);

  const { data: quote, mutate } = useSWR<Quote>(
    validMint ? `/api/listings?mint=${validMint}` : null,
    fetcher,
    {
      // Paired after all, from another tab or an earlier retry: nothing is left to report.
      onSuccess: (q) => {
        if (q.pair) clearUnrecorded("pair", q.mint);
      },
    },
  );
  const unrecorded = (validMint && !quote?.pair && waiting[validMint]) || null;

  const isCreator = quote?.creator != null && quote.creator === payer;
  const open = quote != null && !quote.error && quote.tradeable && quote.pair == null;

  /**
   * Report a payment and settle what the page shows. The server reads the payment back from the
   * chain, so reporting the same one again is safe, and a payment already used is refused.
   */
  const report = useCallback(
    async (body: PairReport) => {
      const res = await postRecord("/api/listings", body);
      if (res.ok) {
        clearUnrecorded("pair", body.mint);
        setDone({ signature: body.signature, pair: String(res.data.pair ?? body.ticker) });
        setPicked(null);
        mutate();
        onListed?.();
        return;
      }
      if (res.final) {
        // Refused for good: the token has a pair, or this payment was already used for one.
        clearUnrecorded("pair", body.mint);
        setError(res.error);
        mutate();
        return;
      }
      saveUnrecorded("pair", body.mint, { body, error: res.error });
    },
    [mutate, onListed],
  );

  const retry = useCallback(async () => {
    if (!unrecorded) return;
    setBusy(true);
    setError(null);
    try {
      await report(unrecorded.body);
    } finally {
      setBusy(false);
    }
  }, [unrecorded, report]);

  const forget = useCallback(() => {
    if (unrecorded) clearUnrecorded("pair", unrecorded.body.mint);
  }, [unrecorded]);

  const pay = useCallback(async () => {
    if (!publicKey || !signTransaction || !validMint || !picked || !quote?.cook || !quote.operator) {
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(quote.operator),
          lamports: BigInt(Math.ceil(quote.cook * 10 ** COOK_DECIMALS)),
        }),
      );
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sent = await signSendConfirm(connection, tx, signTransaction);

      // The pair is recorded against the payment: the server reads what actually reached the
      // operator and checks the payer is the token's creator.
      await report({
        signature: sent.signature,
        mint: validMint,
        payer: publicKey.toBase58(),
        ticker: picked,
      });
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [publicKey, signTransaction, validMint, picked, quote, connection, report]);

  return (
    <div className="card mt-10 p-5 sm:p-7">
      <h2 className="title text-primary">Set a token&apos;s pair</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">
        Every token has one pair, and its holders are paid in that asset. A token launched on Coorwa
        picks it at launch. For any other token, its creator picks it here once, for{" "}
        {usd(quote?.usd ?? 1)} in COOK, which joins the token&apos;s holder rewards. It cannot be
        changed afterwards.
      </p>

      <div className="mt-6 space-y-4">
        <label className="block">
          <span className="label mb-1.5 block text-[12px]">Token mint</span>
          <input
            value={mint}
            onChange={(e) => {
              setTyped(e.target.value.trim());
              setDone(null);
              setError(null);
            }}
            placeholder="The mint address of your token"
            className="field num w-full"
          />
        </label>

        {mint.length > 0 && !validMint && (
          <Notice tone="note">That does not look like a mint address.</Notice>
        )}

        {validMint && quote && !quote.error && !quote.tradeable && (
          <Notice tone="note">
            This token has no pool on Cookie Chain with real liquidity, so a pair on it could not be
            traded or priced.
          </Notice>
        )}

        {validMint && quote?.pair && (
          <Notice tone="note">
            Paired with <span className="num">{quote.pair}</span>
            {quote.pin ? ", picked at launch" : ""}. A token keeps its one pair.
          </Notice>
        )}

        {validMint && open && (
          <>
            <p className="text-[13px] text-muted">
              {quote.creator ? (
                <>
                  Only the creator, <span className="num">{shortAddr(quote.creator, 5)}</span>, can
                  set this pair.
                </>
              ) : (
                "Coorwa cannot tell who created this token, so nobody can set its pair here."
              )}
            </p>

            {isCreator && (
              <div>
                <span className="label mb-2 block text-[12px]">Asset holders are paid in</span>
                <div className="flex flex-wrap gap-2">
                  {RWA_ASSETS.map((a) => (
                    <button
                      key={a.ticker}
                      onClick={() => {
                        setPicked(a.ticker);
                        setDone(null);
                        setError(null);
                      }}
                      // Inline, because `.pill-quiet` is a real class and would win the cascade.
                      style={
                        picked === a.ticker
                          ? {
                              background: "var(--amber-glass-fill)",
                              boxShadow: "var(--amber-glass-edge)",
                              color: "var(--accent-contrast)",
                            }
                          : undefined
                      }
                      className="pill num pill-quiet"
                      title={a.name}
                    >
                      {a.ticker}
                    </button>
                  ))}
                </div>
                {quote.cook != null && (
                  <p className="num mt-3 text-[13px] text-muted">
                    {usd(quote.usd)}, about {amount(quote.cook)} COOK
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {error && <Notice tone="down">{error}</Notice>}

        {unrecorded && (
          <Notice tone="down">
            Your payment for {unrecorded.body.ticker} went through (
            <a
              href={cookieTxUrl(unrecorded.body.signature)}
              target="_blank"
              rel="noreferrer"
              className="num underline underline-offset-4"
            >
              {shortAddr(unrecorded.body.signature, 6)}
            </a>
            ), but the pair was not saved: {unrecorded.error}. Try again sends the same payment, so
            you do not pay twice.
            <span className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-primary" disabled={busy} onClick={retry}>
                {busy ? "Saving the pair" : "Try again"}
              </button>
              <button className="btn btn-quiet" disabled={busy} onClick={forget}>
                Forget this payment
              </button>
            </span>
          </Notice>
        )}

        {done && (
          <Notice tone="up">
            Paired with {done.pair}.{" "}
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
          open &&
          isCreator &&
          !unrecorded && (
            <button
              className="btn btn-primary"
              disabled={busy || !picked || !quote?.cook || !quote.operator}
              onClick={pay}
            >
              {busy ? "Confirm in your wallet" : picked ? `Pair with ${picked}` : "Pick an asset"}
            </button>
          )
        )}
      </div>
    </div>
  );
}
