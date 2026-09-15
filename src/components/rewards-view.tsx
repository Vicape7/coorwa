"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { usd, amount, shortAddr, timeAgo } from "@/lib/format";
import {
  cookieTxUrl,
  CASHBACK_SPLIT,
  COORWA_SWAP_FEE_BPS,
  COOK_SYMBOL,
  PAIR_LISTING_USD,
  VAULT_MINT,
} from "@/lib/config";
import { claimInstructions } from "@/lib/vault";
import { signSendConfirm, explainError } from "@/lib/tx";
import { Notice } from "./notice";
import { VaultAdmin } from "./vault-admin";
import { RwaPayout } from "./rwa-payout";
import type { CashbackSummary } from "@/lib/cashback";
import type { ClaimableReport } from "@/lib/epochs";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const MINT = new PublicKey(VAULT_MINT);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function RewardsView() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const wallet = publicKey?.toBase58();

  const { data, mutate } = useSWR<CashbackSummary>(
    wallet ? `/api/rewards?wallet=${wallet}` : "/api/rewards",
    fetcher,
    { refreshInterval: 30_000 },
  );

  const { data: vault, mutate: refreshVault } = useSWR<ClaimableReport>(
    wallet ? `/api/cashback/claimable?wallet=${wallet}` : "/api/cashback/claimable",
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [claiming, setClaiming] = useState(false);
  const [claimNote, setClaimNote] = useState<{ tone: "up" | "down"; text: string } | null>(null);

  const open = useMemo(() => vault?.lines.filter((l) => l.claimable) ?? [], [vault]);

  /**
   * Why the button cannot be pressed, said plainly. An empty reason means it can.
   *
   * Each of these is a different truth and they used to be one disabled button with one tooltip.
   * "Nothing has been published yet" and "there is no vault here" are not the same problem, and a
   * claimant deserves to know which one they are looking at.
   */
  const blocked = !vault
    ? "Checking the vault."
    : !vault.deployed
      ? "The cashback vault is not deployed on this network yet."
      : !vault.vault
        ? "The vault has not been opened for COOK yet."
        : open.length === 0
          ? "Your balance is accruing. It becomes claimable when the next root is published."
          : null;

  /**
   * Claim every open epoch, one transaction each.
   *
   * One per epoch rather than all in one, because a proof grows with the size of the tree and a
   * batch would silently stop fitting in a transaction as Coorwa gets busier. Each claim stands on
   * its own, so a wallet that rejects the second signature keeps the first.
   */
  const onClaim = useCallback(async () => {
    if (!publicKey || !signTransaction || open.length === 0) return;
    setClaiming(true);
    setClaimNote(null);

    let last: string | null = null;
    try {
      for (const line of open) {
        const tx = new Transaction().add(
          ...claimInstructions({
            claimant: publicKey,
            mint: MINT,
            index: BigInt(line.epoch),
            amount: BigInt(line.amountRaw),
            proof: line.proof.map(hexToBytes),
          }),
        );
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;

        const sent = await signSendConfirm(connection, tx, signTransaction);
        if (!sent.confirmed) throw new Error("the claim did not confirm");
        last = sent.signature;

        // Nothing depends on this landing: the vault's own claim record is what the next read
        // believes. It is here so the claimant keeps a link to their transaction.
        await fetch("/api/cashback/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signature: sent.signature, wallet, epoch: line.epoch }),
        }).catch(() => undefined);
      }
      if (last) setClaimNote({ tone: "up", text: last });
    } catch (e) {
      setClaimNote({ tone: "down", text: explainError(e) });
    } finally {
      setClaiming(false);
      await Promise.all([refreshVault(), mutate()]);
    }
  }, [publicKey, signTransaction, connection, open, wallet, refreshVault, mutate]);

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Cashback</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          The fees you generate, returned.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Coorwa rebates the fees it earns rather than keeping them. Three things fill the vault: the
          launchpad referral share, Coorwa&apos;s own {(COORWA_SWAP_FEE_BPS / 100).toFixed(2)}% fee on
          a swap, and the fee a creator pays to list a pair. All of it is paid back out of the same
          vault, against a root anyone can check.
        </p>
      </div>

      {/* Balance */}
      <div className="card mt-10 p-8">
        {!wallet ? (
          <div className="flex flex-wrap items-center gap-5">
            <div>
              <div className="text-[15px] text-primary">Your cashback</div>
              <p className="mt-1 text-[14px] text-muted">
                Connect to see what you have accrued as a trader and as a creator.
              </p>
            </div>
            <button className="btn btn-primary ml-auto" onClick={() => setVisible(true)}>
              Connect wallet
            </button>
          </div>
        ) : !data ? (
          <div className="skeleton h-24 w-full" />
        ) : !data.configured ? (
          <div>
            <div className="text-[15px] text-primary">Accounting is not configured here</div>
            <p className="mt-2 max-w-2xl text-[14px] leading-[1.7] text-muted">
              Cashback needs history, so it needs a database. Trading, launching and providing
              liquidity are entirely on-chain and work without one - this page is the only part that
              does not. Set <span className="num text-primary">DATABASE_URL</span> to enable it.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-8 sm:grid-cols-3">
              <Figure
                label="Claimable now"
                value={`${amount(vault?.claimableCook ?? 0, 3)} ${COOK_SYMBOL}`}
                sub={
                  open.length === 0
                    ? "Nothing published for you yet"
                    : `Across ${open.length} epoch${open.length > 1 ? "s" : ""}, ready to sign`
                }
                emphasis
              />
              <Figure
                label="Accruing"
                value={usd(data.pendingUsd)}
                sub="Earned, waiting for the next root"
              />
              <Figure label="Claimed" value={usd(data.paidUsd)} sub="Paid out of the vault to you" />
            </div>

            <div className="mt-8 border-t border-hair pt-6 text-[13px] text-muted">
              <span className="num text-primary">{usd(data.traderAccruedUsd)}</span> as a trader ·{" "}
              <span className="num text-primary">{usd(data.creatorAccruedUsd)}</span> as a creator
            </div>

            {/* A stock first, COOK second: settling into a real asset is what Coorwa is for. */}
            <RwaPayout open={open} onSettled={() => void Promise.all([refreshVault(), mutate()])} />

            <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-hair pt-6">
              <div className="min-w-0 flex-1 text-[13px] text-muted">
                {open.length > 0
                  ? `Or take it as ${COOK_SYMBOL} on Cookie Chain, in one signature per epoch.`
                  : `Paid as a stock on Solana, or as ${COOK_SYMBOL} on Cookie Chain.`}
              </div>
              <button
                className="btn btn-ghost"
                disabled={blocked !== null || claiming}
                title={blocked ?? undefined}
                onClick={onClaim}
              >
                {claiming
                  ? "Claiming"
                  : open.length > 0
                    ? `Claim ${amount(vault?.claimableCook ?? 0, 3)} ${COOK_SYMBOL} instead`
                    : `Claim as ${COOK_SYMBOL}`}
              </button>
            </div>

            {claimNote && (
              <div className="mt-4">
                <Notice tone={claimNote.tone}>
                  {claimNote.tone === "up" ? (
                    <>
                      Paid.{" "}
                      <a
                        href={cookieTxUrl(claimNote.text)}
                        target="_blank"
                        rel="noreferrer"
                        className="num underline underline-offset-4"
                      >
                        {shortAddr(claimNote.text, 6)}
                      </a>
                    </>
                  ) : (
                    claimNote.text
                  )}
                </Notice>
              </div>
            )}

            <p className="mt-3 text-[12px] leading-relaxed text-subtle">
              {blocked ??
                "The claim is yours to sign. Coorwa publishes a merkle root of who is owed what, and the program pays your line against your own proof - it never holds a key that could pay anyone else."}
            </p>

            {vault && vault.lines.length > 0 && <EpochLines lines={vault.lines} />}
          </>
        )}
      </div>

      {/* Operator surface. Renders nothing at all unless the connected wallet is the authority. */}
      <VaultAdmin />

      {/* History */}
      {data?.configured && wallet && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4">
            <h2 className="title text-primary">Your fills</h2>
          </div>
          {data.recent.length === 0 ? (
            <p className="px-6 pb-6 text-[14px] text-muted">
              Nothing routed through Coorwa from this wallet yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-[14px]">
                <thead>
                  <tr>
                    <Th>Token</Th>
                    <Th>Side</Th>
                    <Th align="right">Value</Th>
                    <Th align="right">Fee earned</Th>
                    <Th align="right">Your share</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.signature} className="row-hover">
                      <td className="px-6 py-2.5">
                        <a
                          href={cookieTxUrl(r.signature)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline decoration-[color:var(--divider-strong)] underline-offset-4"
                        >
                          {r.symbol ?? shortAddr(r.signature, 4)}
                        </a>
                      </td>
                      <td
                        className="px-6 py-2.5"
                        style={{ color: r.side === "buy" ? "var(--color-up)" : "var(--color-down)" }}
                      >
                        {r.side}
                      </td>
                      <td className="num px-6 py-2.5 text-right text-primary">{usd(r.valueUsd)}</td>
                      <td className="num px-6 py-2.5 text-right text-muted">{usd(r.feeUsd)}</td>
                      <td className="num px-6 py-2.5 text-right text-primary">
                        {usd(r.shareUsd)}
                      </td>
                      <td className="num px-6 py-2.5 text-right text-muted">
                        {timeAgo(new Date(r.createdAt).getTime())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Where it comes from */}
      <div className="card mt-4 p-8">
        <h2 className="title text-primary">Where cashback comes from today</h2>
        <dl className="mt-6 divide-y divide-[color:var(--divider)]">
          <Source
            label="Launchpad fills"
            state="Free to you"
            tone="up"
            body={`Every buy Coorwa routes on a MomoSwap curve names Coorwa as referrer, which pays 20% of the 1% trade fee. MomoSwap pays that out of the same fee whether or not anyone is named, so it costs you nothing. ${pct(CASHBACK_SPLIT.trader)} of it comes back to you.`}
          />
          <Source
            label="Swap fills"
            state={`${(COORWA_SWAP_FEE_BPS / 100).toFixed(2)}% fee`}
            tone="muted"
            body={`Neither Cookie Chain router pays a referrer, so Coorwa charges its own fee on a terminal swap, and on the Cookie Chain swap inside a cross-chain settlement or payout. It is a fee, not a freebie: it comes out of your trade and is shown before you sign. None of it is kept. ${pct(CASHBACK_SPLIT.trader)} comes back to you and ${pct(CASHBACK_SPLIT.creator)} goes to the token's creator, so routing through Coorwa leaves you about ${((COORWA_SWAP_FEE_BPS / 100) * CASHBACK_SPLIT.creator).toFixed(3)}% behind trading direct.`}
          />
          <Source
            label="Pair listings"
            state="To the pair's traders"
            tone="up"
            body={`Anyone can pay $${PAIR_LISTING_USD} to add a pair to a token. That money goes to the wallets that traded the pair since the previous epoch, in proportion to the Coorwa fee each paid on it, and none of it to the creator or to whoever paid. A pair nobody traded keeps its share for the next epoch.`}
          />
          <Source
            label="LP fees"
            state="Yours already"
            tone="muted"
            body="Fees on a position you own are paid to you by the pool directly, and Coorwa takes nothing from them. It builds the claim, and can settle what you claim into an xStock on Solana."
          />
        </dl>
      </div>

      {/* Split + leaderboard */}
      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        <div className="card p-8">
          <h2 className="title text-primary">How a fee is split</h2>
          <dl className="mt-6 space-y-4">
            <Split
              pct={CASHBACK_SPLIT.trader}
              label="Trader"
              body="Back to whoever generated the fee, paid as an xStock on Solana or as COOK."
            />
            <Split
              pct={CASHBACK_SPLIT.creator}
              label="Creator"
              body="To whoever launched the token being traded, on top of MomoSwap's own creator fee."
            />
          </dl>
          <p className="mt-6 text-[13px] leading-relaxed text-muted">
            The same for a launchpad referral, a swap fee and the swap inside a settlement. Coorwa
            keeps none of it.
          </p>
        </div>

        <div className="card p-8">
          <h2 className="title text-primary">Most routed</h2>
          {!data?.leaderboard?.length ? (
            <p className="mt-4 text-[14px] text-muted">No volume routed yet.</p>
          ) : (
            <ol className="mt-6 space-y-3">
              {data.leaderboard.map((row, i) => (
                <li key={row.wallet} className="flex items-center gap-4">
                  <span className="num w-5 shrink-0 text-[13px] text-subtle">{i + 1}</span>
                  <span className="num flex-1 truncate text-[14px] text-primary">
                    {shortAddr(row.wallet, 5)}
                  </span>
                  <span className="num text-[14px] text-muted">{usd(row.volumeUsd)}</span>
                  <span className="num w-20 shrink-0 text-right text-[14px] text-primary">
                    {usd(row.accruedUsd)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The wallet's own lines, epoch by epoch.
 *
 * This is the part that makes the balance checkable rather than asserted: the epoch index and the
 * root are on chain, and the amount below is the one hashed into the leaf a claim opens.
 */
function EpochLines({ lines }: { lines: ClaimableReport["lines"] }) {
  return (
    <div className="mt-6 border-t border-hair pt-5">
      <div className="label text-[12px]">Your epochs</div>
      <ul className="mt-3 space-y-2.5">
        {lines.map((l) => (
          <li key={l.epoch} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
            <span className="num w-10 shrink-0 text-subtle">#{l.epoch}</span>
            <span className="num text-primary">
              {amount(l.amountCook, 3)} {COOK_SYMBOL}
            </span>
            <span className="num text-muted">{usd(l.amountUsd)}</span>
            <span className="ml-auto text-muted">
              {l.claimed ? (
                l.signature ? (
                  <a
                    href={cookieTxUrl(l.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="num underline decoration-[color:var(--divider-strong)] underline-offset-4"
                  >
                    claimed
                  </a>
                ) : (
                  "claimed"
                )
              ) : l.claimable ? (
                `open until ${new Date(l.deadline).toLocaleDateString()}`
              ) : (
                "expired unclaimed, rolled into a later epoch"
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="label text-[12px]">{label}</div>
      <div
        className={`num display mt-2 text-primary ${emphasis ? "text-[44px]" : "text-[32px]"}`}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[13px] text-muted">{sub}</div>
    </div>
  );
}

function Source({
  label,
  state,
  tone,
  body,
}: {
  label: string;
  state: string;
  tone: "up" | "muted";
  body: string;
}) {
  return (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:gap-6">
      <div className="w-44 shrink-0">
        <dt className="text-[14px] text-primary">{label}</dt>
        <span
          className="pill mt-1.5"
          style={
            tone === "up"
              ? {
                  background: "color-mix(in srgb, var(--color-up) 12%, transparent)",
                  color: "var(--color-up)",
                }
              : { background: "var(--surface-raised)", color: "var(--text-muted)" }
          }
        >
          {state}
        </span>
      </div>
      <dd className="text-[14px] leading-[1.7] text-muted">{body}</dd>
    </div>
  );
}

function pct(share: number): string {
  return `${Number((share * 100).toFixed(1))}%`;
}

function Split({ pct, label, body }: { pct: number; label: string; body: string }) {
  return (
    <div className="flex items-baseline gap-5">
      <dt className="num display w-20 shrink-0 text-[28px] text-primary">
        {Number((pct * 100).toFixed(1))}
        <span className="text-[16px] text-subtle">%</span>
      </dt>
      <dd>
        <div className="text-[14px] text-primary">{label}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-muted">{body}</div>
      </dd>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`label whitespace-nowrap px-6 py-2 text-[12px] font-normal ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
