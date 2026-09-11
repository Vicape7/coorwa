"use client";

/**
 * The vault operator panel.
 *
 * This is the only place where cashback stops being a report and starts being money, and it is
 * built so that no key ever reaches Coorwa's server. The authority signs `initialize`, `fund` and
 * `publish_epoch` in their own browser, exactly like a trader signs a swap. The server's part is
 * arithmetic: it works out the leaves, and afterwards it reads the published transaction back off
 * the chain to check it got the root it expected.
 *
 * Hidden from everyone but the authority. Before a vault exists there is no authority to compare
 * against, so it appears for the wallet named by NEXT_PUBLIC_VAULT_AUTHORITY and nobody else.
 */
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { Notice } from "./notice";
import { amount, shortAddr, usd } from "@/lib/format";
import { signSendConfirm, explainError } from "@/lib/tx";
import {
  COOK_DECIMALS,
  COOK_SYMBOL,
  VAULT_AUTHORITY,
  VAULT_MINT,
  VAULT_PROGRAM_ADDRESS,
  cookieAccountUrl,
  cookieTxUrl,
} from "@/lib/config";
import { closeEpochIx, fundTransaction, initializeIx, publishEpochIx } from "@/lib/vault";
import type { EpochOverview, EpochRow } from "@/lib/epochs";

const MINT = new PublicKey(VAULT_MINT);
const UNITS = 10 ** COOK_DECIMALS;

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface DraftLine {
  wallet: string;
  amountCook: number;
  amountUsd: number;
  traderUsd: number;
  creatorUsd: number;
}

interface DraftResponse {
  epoch: EpochRow;
  reused: boolean;
  freeCook: number;
  shortfallCook: number;
  lines: DraftLine[];
  truncated: number;
  error?: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function VaultAdmin() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const { data, mutate } = useSWR<EpochOverview>("/api/cashback/epochs", fetcher, {
    refreshInterval: 30_000,
  });

  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "up" | "down" | "note"; text: string } | null>(null);
  const [fundInput, setFundInput] = useState("");

  const visible = useMemo(() => {
    if (!wallet) return false;
    // Once the vault exists the chain decides. Before that, one named wallet does.
    if (data?.vault) return data.vault.authority === wallet;
    return VAULT_AUTHORITY !== "" && VAULT_AUTHORITY === wallet;
  }, [wallet, data?.vault]);

  /** Every action here is the same three steps, so they share one runner. */
  const run = useCallback(
    async (
      key: string,
      build: () => Promise<Transaction>,
      after?: (sig: string) => Promise<void>,
    ) => {
      if (!publicKey || !signTransaction) return;
      setBusy(key);
      setNote(null);
      try {
        const tx = await build();
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;

        const sent = await signSendConfirm(connection, tx, signTransaction);
        if (!sent.confirmed) throw new Error("the transaction did not confirm");
        await after?.(sent.signature);
        setNote({ tone: "up", text: sent.signature });
        await mutate();
      } catch (e) {
        setNote({ tone: "down", text: explainError(e) });
      } finally {
        setBusy(null);
      }
    },
    [publicKey, signTransaction, connection, mutate],
  );

  const onInitialize = useCallback(
    () => run("init", async () => new Transaction().add(initializeIx(publicKey!, MINT))),
    [run, publicKey],
  );

  /**
   * Fund the vault, wrapping native COOK first when the wallet has no wrapped balance to spend.
   *
   * The wrapped account is left open rather than closed afterwards. Closing it would unwrap
   * everything in it, and a wallet that already held wrapped COOK for other reasons would lose
   * that balance to a convenience it never asked for.
   */
  const onFund = useCallback(() => {
    const cook = Number(fundInput);
    if (!(cook > 0)) {
      setNote({ tone: "down", text: "Enter how much COOK to move into the vault." });
      return;
    }
    const raw = BigInt(Math.floor(cook * UNITS));

    return run("fund", () => fundTransaction(connection, publicKey!, MINT, raw));
  }, [run, fundInput, publicKey, connection]);

  const onDraft = useCallback(async (rebuild: boolean) => {
    setBusy(rebuild ? "rebuild" : "draft");
    setNote(null);
    try {
      const res = await fetch("/api/cashback/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rebuild }),
      });
      const body: DraftResponse = await res.json();
      if (!res.ok) throw new Error(body.error ?? "could not build the epoch");
      setDraft(body);
    } catch (e) {
      setNote({ tone: "down", text: explainError(e) });
    } finally {
      setBusy(null);
    }
  }, []);

  const onPublish = useCallback(() => {
    if (!draft) return;
    const e = draft.epoch;

    return run(
      "publish",
      async () =>
        new Transaction().add(
          publishEpochIx({
            authority: publicKey!,
            mint: MINT,
            index: BigInt(e.index),
            root: hexToBytes(e.root),
            total: BigInt(e.totalRaw),
            claimants: e.claimants,
            deadline: Math.floor(new Date(e.deadline).getTime() / 1000),
          }),
        ),
      async (signature) => {
        // Only now does the epoch become real to Coorwa, and only because the chain says so.
        const res = await fetch("/api/cashback/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signature }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "published on chain, but Coorwa could not record it");
        }
        setDraft(null);
      },
    );
  }, [draft, run, publicKey]);

  const onClose = useCallback(
    (index: string) =>
      run(`close:${index}`, async () => new Transaction().add(closeEpochIx(MINT, BigInt(index)))),
    [run],
  );

  if (!visible) return null;

  const vault = data?.vault ?? null;

  return (
    <div className="card mt-4 p-8">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="title text-primary">Vault</h2>
        <span className="pill pill-quiet">Authority</span>
        <a
          href={cookieAccountUrl(VAULT_PROGRAM_ADDRESS)}
          target="_blank"
          rel="noreferrer"
          className="num ml-auto text-[12px] text-subtle underline decoration-[color:var(--divider-strong)] underline-offset-4"
        >
          {shortAddr(VAULT_PROGRAM_ADDRESS, 6)}
        </a>
      </div>

      {!data?.deployed ? (
        <p className="mt-4 max-w-2xl text-[14px] leading-[1.7] text-muted">
          The program is not on this chain. Deploy it with{" "}
          <span className="num text-primary">npm run program:deploy</span>, then come back and
          initialize the vault.
        </p>
      ) : !vault ? (
        <>
          <p className="mt-4 max-w-2xl text-[14px] leading-[1.7] text-muted">
            The program is live but no vault has been opened for {COOK_SYMBOL} yet. Whoever signs
            this becomes the authority, and the authority can only publish roots - there is no
            instruction that lets it spend the float.
          </p>
          <button className="btn btn-primary mt-5" disabled={busy !== null} onClick={onInitialize}>
            {busy === "init" ? "Initializing" : "Initialize the vault"}
          </button>
        </>
      ) : (
        <>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <Figure label="Held" value={`${amount(vault.balanceCook, 3)} ${COOK_SYMBOL}`} />
            <Figure
              label="Reserved"
              value={`${amount(vault.reservedCook, 3)} ${COOK_SYMBOL}`}
              sub="Promised to open epochs"
            />
            <Figure
              label="Free"
              value={`${amount(vault.freeCook, 3)} ${COOK_SYMBOL}`}
              sub="What the next root can be backed by"
            />
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-hair pt-6">
            <input
              className="field w-40"
              inputMode="decimal"
              placeholder={`0.0 ${COOK_SYMBOL}`}
              value={fundInput}
              onChange={(ev) => setFundInput(ev.target.value)}
            />
            <button className="btn btn-ghost" disabled={busy !== null} onClick={onFund}>
              {busy === "fund" ? "Funding" : "Fund"}
            </button>
            <button
              className="btn btn-ghost ml-auto"
              disabled={busy !== null}
              onClick={() => onDraft(false)}
            >
              {busy === "draft" ? "Building" : "Build the next epoch"}
            </button>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-subtle">
            Funding is one way. Tokens leave the vault only through an epoch that names their
            recipient, so a mistake here can only be recovered by publishing a root that pays it
            back.
          </p>
        </>
      )}

      {draft && (
        <DraftCard
          draft={draft}
          busy={busy}
          onPublish={onPublish}
          onRebuild={() => onDraft(true)}
        />
      )}

      {data?.closable && data.closable.length > 0 && (
        <div className="mt-6 border-t border-hair pt-6">
          <div className="label text-[12px]">Expired</div>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Closing returns an expired epoch&apos;s unclaimed reserve to the vault so a later root
            can use it. Anyone may do it, and it moves no tokens out.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {data.closable.map((index) => (
              <button
                key={index}
                className="btn btn-quiet btn-sm"
                disabled={busy !== null}
                onClick={() => onClose(index)}
              >
                {busy === `close:${index}` ? "Closing" : `Close epoch ${index}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {note && (
        <div className="mt-5">
          <Notice tone={note.tone}>
            {note.tone === "up" ? (
              <>
                Confirmed.{" "}
                <a
                  href={cookieTxUrl(note.text)}
                  target="_blank"
                  rel="noreferrer"
                  className="num underline underline-offset-4"
                >
                  {shortAddr(note.text, 6)}
                </a>
              </>
            ) : (
              note.text
            )}
          </Notice>
        </div>
      )}

      {data?.epochs && data.epochs.length > 0 && <EpochTable epochs={data.epochs} />}
    </div>
  );
}

function DraftCard({
  draft,
  busy,
  onPublish,
  onRebuild,
}: {
  draft: DraftResponse;
  busy: string | null;
  onPublish: () => void;
  onRebuild: () => void;
}) {
  const short = draft.shortfallCook > 0;

  return (
    <div className="mt-6 border-t border-hair pt-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <div className="label text-[12px]">Epoch {draft.epoch.index}</div>
        {draft.reused && <span className="pill pill-quiet">Already drafted</span>}
      </div>

      <div className="mt-4 grid gap-6 sm:grid-cols-3">
        <Figure
          label="Total"
          value={`${amount(draft.epoch.totalCook, 3)} ${COOK_SYMBOL}`}
          sub={usd(draft.epoch.totalUsd)}
        />
        <Figure label="Claimants" value={String(draft.epoch.claimants)} />
        <Figure
          label="Rate"
          value={usd(draft.epoch.cookPriceUsd)}
          sub={`per ${COOK_SYMBOL}, fixed for this epoch`}
        />
      </div>

      <div className="num mt-4 break-all text-[12px] text-subtle">{draft.epoch.root}</div>

      {short && (
        <div className="mt-4">
          <Notice tone="down">
            The vault is {amount(draft.shortfallCook, 3)} {COOK_SYMBOL} short of backing this root,
            so the program would refuse it. Fund it first.
          </Notice>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-[14px]">
          <tbody>
            {draft.lines.map((l) => (
              <tr key={l.wallet} className="row-hover">
                <td className="num py-2 pr-6 text-primary">{shortAddr(l.wallet, 5)}</td>
                <td className="num py-2 pr-6 text-right text-muted">{usd(l.traderUsd)}</td>
                <td className="num py-2 pr-6 text-right text-muted">{usd(l.creatorUsd)}</td>
                <td className="num py-2 text-right text-primary">
                  {amount(l.amountCook, 3)} {COOK_SYMBOL}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {draft.truncated > 0 && (
          <p className="mt-2 text-[12px] text-subtle">and {draft.truncated} more</p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button className="btn btn-primary" disabled={busy !== null || short} onClick={onPublish}>
          {busy === "publish" ? "Publishing" : "Publish this root"}
        </button>
        <button className="btn btn-quiet" disabled={busy !== null} onClick={onRebuild}>
          {busy === "rebuild" ? "Rebuilding" : "Rebuild"}
        </button>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-subtle">
        Rebuilding takes a fresh cutoff and produces a different root, so do it before signing
        rather than after. A root that is published without matching leaves cannot be claimed.
      </p>
    </div>
  );
}

function EpochTable({ epochs }: { epochs: EpochRow[] }) {
  return (
    <div className="mt-6 overflow-x-auto border-t border-hair pt-6">
      <table className="w-full min-w-[560px] text-[14px]">
        <thead>
          <tr>
            <Th>Epoch</Th>
            <Th align="right">Total</Th>
            <Th align="right">Claimed</Th>
            <Th align="right">Claimants</Th>
            <Th align="right">State</Th>
          </tr>
        </thead>
        <tbody>
          {epochs.map((e) => (
            <tr key={e.index} className="row-hover">
              <td className="num py-2.5 text-primary">
                {e.signature ? (
                  <a
                    href={cookieTxUrl(e.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-[color:var(--divider-strong)] underline-offset-4"
                  >
                    {e.index}
                  </a>
                ) : (
                  e.index
                )}
              </td>
              <td className="num py-2.5 text-right text-primary">{amount(e.totalCook, 3)}</td>
              <td className="num py-2.5 text-right text-muted">
                {e.onChain ? amount(e.onChain.claimedCook, 3) : "—"}
              </td>
              <td className="num py-2.5 text-right text-muted">
                {e.onChain ? `${e.onChain.claimedCount}/${e.claimants}` : e.claimants}
              </td>
              <td className="py-2.5 text-right text-[13px] text-muted">
                {e.status === "draft"
                  ? "draft"
                  : e.onChain?.closed
                    ? "closed"
                    : e.onChain?.expired
                      ? "expired"
                      : "open"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="label text-[12px]">{label}</div>
      <div className="num mt-1.5 text-[22px] text-primary">{value}</div>
      {sub && <div className="mt-1 text-[13px] text-muted">{sub}</div>}
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`label whitespace-nowrap py-2 text-[12px] font-normal ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
