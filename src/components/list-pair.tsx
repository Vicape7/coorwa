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

export function ListPair({ onListed }: { onListed?: () => void }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [mint, setMint] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ signature: string; pair: string } | null>(null);

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
  );

  const wallet = publicKey?.toBase58() ?? null;
  const isCreator = quote?.creator != null && quote.creator === wallet;
  const open = quote != null && !quote.error && quote.tradeable && quote.pair == null;

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
      const res = await fetch("/api/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signature: sent.signature,
          mint: validMint,
          payer: publicKey.toBase58(),
          ticker: picked,
        }),
      }).then((r) => r.json());

      if (res.error) throw new Error(res.error);

      setDone({ signature: sent.signature, pair: res.pair });
      setPicked(null);
      mutate();
      onListed?.();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, [publicKey, signTransaction, validMint, picked, quote, connection, mutate, onListed]);

  return (
    <div className="card mt-10 p-7">
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
              setMint(e.target.value.trim());
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
          isCreator && (
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
