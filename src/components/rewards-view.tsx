"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { usd, amount, shortAddr } from "@/lib/format";
import {
  cookieTxUrl,
  CASHBACK_SPLIT,
  COORWA_SWAP_FEE_BPS,
  HOLDER_MIN_USD,
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
        <span className="label text-[12px]">Rewards</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Hold a token, get paid in its stock.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Every fee Coorwa earns on a token goes back to the people holding it and to whoever made
          it. Coorwa keeps none of it. Each epoch takes a snapshot of who holds every token with
          rewards waiting, shares them out by how much each wallet holds, and publishes the result
          as a root anyone can check. You claim as an xStock on Solana, or as COOK.
        </p>
      </div>

      {/* Balance */}
      <div className="card mt-10 p-8">
        {!wallet ? (
          <div className="flex flex-wrap items-center gap-5">
            <div>
              <div className="text-[15px] text-primary">Your rewards</div>
              <p className="mt-1 text-[14px] text-muted">
                Connect to see what you have been paid as a holder and earned as a creator.
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
              Rewards need history, so they need a database. Trading, launching and providing
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
                sub="Owed, not yet in an open epoch"
              />
              <Figure label="Claimed" value={usd(data.paidUsd)} sub="Paid out of the vault to you" />
            </div>

            <div className="mt-8 border-t border-hair pt-6 text-[13px] text-muted">
              <span className="num text-primary">{usd(data.holderEarnedUsd)}</span> as a holder ·{" "}
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
                "The claim is yours to sign. Every day Coorwa publishes a merkle root of who is owed what, and the program pays your line only against your own proof and your own signature."}
            </p>

            {vault && vault.lines.length > 0 && <EpochLines lines={vault.lines} />}
          </>
        )}
      </div>

      {/* Operator surface. Renders nothing at all unless the connected wallet is the authority. */}
      <VaultAdmin />

      {/* This wallet's share of what is waiting, from the samples so far */}
      {data?.configured && wallet && data.estimates.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 pt-5">
            <h2 className="title text-primary">Your share of the next epoch</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              An estimate from the holder snapshots taken so far. Snapshots are taken at random
              moments through the epoch, so holding the whole time is what keeps your share.
            </p>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-[14px]">
              <thead>
                <tr>
                  <Th>Token</Th>
                  <Th align="right">Waiting</Th>
                  <Th align="right">Your share</Th>
                  <Th align="right">About</Th>
                </tr>
              </thead>
              <tbody>
                {data.estimates.map((e) => (
                  <tr key={e.mint} className="row-hover">
                    <td className="px-6 py-2.5 text-primary">{e.symbol ?? shortAddr(e.mint, 4)}</td>
                    <td className="num px-6 py-2.5 text-right text-muted">{usd(e.waitingUsd)}</td>
                    <td className="num px-6 py-2.5 text-right text-muted">
                      {(e.share * 100).toFixed(2)}%
                    </td>
                    <td className="num px-6 py-2.5 text-right text-primary">
                      {usd(e.estimatedUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-6 py-3 text-[12px] text-subtle">
            From {Math.max(...data.estimates.map((e) => e.samples))} snapshot
            {Math.max(...data.estimates.map((e) => e.samples)) === 1 ? "" : "s"} this epoch.
          </p>
        </div>
      )}

      {/* This wallet, token by token */}
      {data?.configured && wallet && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4">
            <h2 className="title text-primary">Your holder rewards</h2>
          </div>
          {data.byToken.length === 0 ? (
            <p className="px-6 pb-6 text-[14px] leading-relaxed text-muted">
              Nothing yet. Hold a token that has rewards waiting below when the next epoch is taken,
              and your share lands here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-[14px]">
                <thead>
                  <tr>
                    <Th>Token</Th>
                    <Th align="right">Epochs</Th>
                    <Th align="right">Paid to you</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.byToken.map((t) => (
                    <tr key={t.mint} className="row-hover">
                      <td className="px-6 py-2.5 text-primary">{t.symbol ?? shortAddr(t.mint, 4)}</td>
                      <td className="num px-6 py-2.5 text-right text-muted">{t.epochs}</td>
                      <td className="num px-6 py-2.5 text-right text-primary">{usd(t.amountUsd)}</td>
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
        <h2 className="title text-primary">Where rewards come from</h2>
        <dl className="mt-6 divide-y divide-[color:var(--divider)]">
          <Source
            label="Launchpad fills"
            state="Free to you"
            tone="up"
            body={`Every buy Coorwa routes on a MomoSwap curve names Coorwa as referrer, which pays 20% of the 1% trade fee. MomoSwap pays that out of the same fee whether or not anyone is named, so it costs the trader nothing. ${pct(CASHBACK_SPLIT.holders)} goes to the token's holders, ${pct(CASHBACK_SPLIT.creator)} to its creator.`}
          />
          <Source
            label="Swap fills"
            state={`${(COORWA_SWAP_FEE_BPS / 100).toFixed(2)}% fee`}
            tone="muted"
            body={`Neither Cookie Chain router pays a referrer, so Coorwa charges its own fee on a terminal swap, and on the Cookie Chain swap inside a cross-chain settlement or payout. It is a fee: it comes out of the trade and is shown before signing. None of it is kept. ${pct(CASHBACK_SPLIT.holders)} goes to the token's holders and ${pct(CASHBACK_SPLIT.creator)} to its creator. A trader who also holds the token gets part of it back as a holder; one who does not, does not.`}
          />
          <Source
            label="Pair listings"
            state="To the token's holders"
            tone="up"
            body={`Anyone can pay $${PAIR_LISTING_USD} to add a pair to a token. All of it joins that token's holder rewards, none of it to the creator or to whoever paid.`}
          />
          <Source
            label="LP fees"
            state="Yours already"
            tone="muted"
            body="Fees on a position you own are paid to you by the pool directly, and Coorwa takes nothing from them. It builds the claim, and can settle what you claim into an xStock on Solana."
          />
        </dl>
      </div>

      {/* Split + pools */}
      <div className="mt-10 grid gap-4 lg:grid-cols-[2fr_3fr]">
        <div className="card p-8">
          <h2 className="title text-primary">How a fee is split</h2>
          <dl className="mt-6 space-y-4">
            <Split
              pct={CASHBACK_SPLIT.holders}
              label="Holders"
              body={`To every wallet holding the token through the epoch, by how much it held across snapshots taken at random moments. A wallet needs at least $${HOLDER_MIN_USD} of the token to count, and pool vaults and programs never do.`}
            />
            <Split
              pct={CASHBACK_SPLIT.creator}
              label="Creator"
              body="To whoever launched the token, on top of MomoSwap's own creator fee."
            />
          </dl>
          <p className="mt-6 text-[13px] leading-relaxed text-muted">
            The same for a launchpad referral, a swap fee and the swap inside a settlement. Coorwa
            keeps none of it.
          </p>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 pt-6">
            <h2 className="title text-primary">Holder rewards by token</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Waiting is shared out when the next epoch is built, over whoever held the token
              through it.
            </p>
          </div>
          {!data?.pools?.length ? (
            <p className="px-6 pb-6 pt-4 text-[14px] text-muted">No fees earned on any token yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[460px] text-[14px]">
                <thead>
                  <tr>
                    <Th>Token</Th>
                    <Th align="right">Waiting</Th>
                    <Th align="right">Paid to holders</Th>
                    <Th align="right">Holders paid</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.pools.map((p) => (
                    <tr key={p.mint} className="row-hover">
                      <td className="px-6 py-2.5 text-primary">{p.symbol ?? shortAddr(p.mint, 4)}</td>
                      <td className="num px-6 py-2.5 text-right text-primary">{usd(p.waitingUsd)}</td>
                      <td className="num px-6 py-2.5 text-right text-muted">
                        {usd(p.distributedUsd)}
                      </td>
                      <td className="num px-6 py-2.5 text-right text-muted">{p.holdersPaid}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
