"use client";

/**
 * Launchpad. Creating a pool is signature-gated by MomoSwap, so the flow is:
 * sign a login message (no chain fee, nothing submitted) -> build -> wallet signs the transaction.
 */
import { useCallback, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { decodeTx, signSendConfirm, explainError } from "@/lib/tx";
import { cookieTxUrl, COOKIE_EXPLORER } from "@/lib/config";
import { shortAddr, amount, usd } from "@/lib/format";
import { Notice } from "./notice";
import type { LaunchpadConfig, LaunchpadPool } from "@/lib/launchpad";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface FeeBreakdown {
  totalPct: number;
  creatorPct: number;
  referralPct: number;
  treasuryPct: number;
  buybackPct: number;
}

export function LaunchView() {
  const { data: cfg } = useSWR<{ config: LaunchpadConfig; fees: FeeBreakdown; error?: string }>(
    "/api/launchpad/config",
    fetcher,
    { refreshInterval: 60_000 },
  );
  const { data: poolsData } = useSWR<{ pools: (LaunchpadPool & { progress: number })[] }>(
    "/api/launchpad/pools?status=all",
    fetcher,
    { refreshInterval: 20_000 },
  );

  const pools = poolsData?.pools ?? [];

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Launchpad</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Launch a token on a COOK curve.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Corwa builds on MomoSwap, Cookie Chain&apos;s bonding-curve launchpad. Your token trades on
          the curve until it hits the graduation target, then moves to a real DEX pool - where it
          becomes a Corwa pair you can price against any stock.
        </p>
      </div>

      <div className="mt-10 grid gap-4 lg:grid-cols-[1fr_400px]">
        <div className="space-y-4">
          <CreateForm config={cfg?.config} />
          {cfg?.config && <Economics config={cfg.config} fees={cfg.fees} />}
        </div>

        <div className="space-y-4">
          <LivePools pools={pools} />
        </div>
      </div>
    </div>
  );
}

// --- Create ---------------------------------------------------------------------------------------

function CreateForm({ config }: { config?: LaunchpadConfig }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signMessage } = useWallet();
  const { setVisible } = useWalletModal();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageType, setImageType] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [durationHours, setDurationHours] = useState(72);
  const [devBuy, setDevBuy] = useState("");

  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ signature: string; mint?: string } | null>(null);

  const onFile = useCallback((file: File) => {
    if (file.size > 2_000_000) {
      setError("Image must be under 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setImagePreview(url);
      setImageBase64(url);
      setImageType(file.type);
      setError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const launch = useCallback(async () => {
    if (!publicKey || !signTransaction) return;
    if (!signMessage) {
      setError("This wallet cannot sign messages, which the launchpad requires to authorise a launch.");
      return;
    }
    setError(null);
    setDone(null);

    try {
      // 1. Session: sign a message. No chain fee, nothing submitted.
      setStep("Requesting a login nonce");
      const nonceRes = await fetch(
        `/api/launchpad/session?wallet=${publicKey.toBase58()}`,
      ).then((r) => r.json());
      if (nonceRes.error) throw new Error(nonceRes.error);

      setStep("Sign the login message in your wallet");
      const sig = await signMessage(new TextEncoder().encode(nonceRes.message));

      setStep("Exchanging the signature for a session");
      const session = await fetch("/api/launchpad/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          ts: nonceRes.ts,
          nonce: nonceRes.nonce,
          signature: bs58.encode(sig),
        }),
      }).then((r) => r.json());
      if (session.error) throw new Error(session.error);

      // 2. Build. The launchpad pins the image, leases a `momo` mint and partial-signs.
      setStep("Pinning metadata and building the launch");
      const built = await fetch("/api/launchpad/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creator: publicKey.toBase58(),
          session: session.token,
          name,
          symbol,
          description: description || undefined,
          imageBase64: imageBase64 ?? undefined,
          imageContentType: imageType ?? undefined,
          durationHours,
          expiryMode: "fair",
          devBuyCook: Number(devBuy) || 0,
        }),
      }).then((r) => r.json());
      if (built.error) throw new Error(built.hint ? `${built.error} - ${built.hint}` : built.error);

      // 3. Sign and send.
      setStep("Confirm the launch in your wallet");
      const sent = await signSendConfirm(
        connection,
        decodeTx(built.transactionBase64),
        signTransaction,
      );

      setDone({ signature: sent.signature, mint: built.mint });
      setName("");
      setSymbol("");
      setDescription("");
      setImageBase64(null);
      setImagePreview(null);
      setDevBuy("");
    } catch (e) {
      setError(explainError(e));
    } finally {
      setStep(null);
    }
  }, [
    publicKey,
    signTransaction,
    signMessage,
    name,
    symbol,
    description,
    imageBase64,
    imageType,
    durationHours,
    devBuy,
    connection,
  ]);

  const ready = name.trim().length > 0 && /^[A-Za-z0-9]{1,10}$/.test(symbol);
  const unavailable = config?.paused || config?.momoReady === 0;

  return (
    <div className="card p-7">
      <h2 className="title text-primary">Create</h2>
      <p className="mt-1.5 text-[13px] text-muted">
        Metadata is immutable once minted - the logo and name cannot be changed later.
      </p>

      <div className="mt-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          <ImagePicker preview={imagePreview} onFile={onFile} />

          <div className="space-y-3">
            <Labeled label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 32))}
                placeholder="Cookie Monster"
                className="field w-full"
              />
            </Labeled>
            <Labeled label="Symbol">
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 10))}
                placeholder="MON"
                className="field w-full uppercase"
              />
            </Labeled>
          </div>
        </div>

        <Labeled label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            rows={3}
            placeholder="What is this token for?"
            className="field w-full resize-none rounded-2xl"
          />
        </Labeled>

        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Curve open for">
            <div className="segmented w-full">
              {[24, 72, 168].map((h) => (
                <button
                  key={h}
                  onClick={() => setDurationHours(h)}
                  data-active={durationHours === h}
                  className="flex-1"
                >
                  {h === 24 ? "1 day" : h === 72 ? "3 days" : "1 week"}
                </button>
              ))}
            </div>
          </Labeled>
          <Labeled label="Buy at launch (COOK, optional)">
            <input
              value={devBuy}
              onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0"
              className="field num w-full"
            />
          </Labeled>
        </div>

        {unavailable && (
          <Notice tone="note">
            {config?.paused
              ? "The launchpad is paused right now."
              : "The launchpad has run out of pre-ground mint addresses. It grinds more continuously - try again shortly."}
          </Notice>
        )}

        {step && <Notice tone="note">{step}</Notice>}
        {error && <Notice tone="down">{error}</Notice>}

        {done && (
          <Notice tone="up">
            Launched.{" "}
            {done.mint && (
              <>
                Mint{" "}
                <a
                  href={`${COOKIE_EXPLORER}/token/${done.mint}`}
                  target="_blank"
                  rel="noreferrer"
                  className="num underline underline-offset-4"
                >
                  {shortAddr(done.mint, 6)}
                </a>
                {" · "}
              </>
            )}
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
          <button className="btn btn-primary w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary w-full"
            disabled={!ready || !!step || unavailable}
            onClick={launch}
          >
            {step ? "Working" : "Launch token"}
          </button>
        )}

        <p className="text-[12px] leading-relaxed text-subtle">
          Two signatures: one message to prove the wallet consented, one transaction to create the
          pool. Corwa never holds your key and never co-signs.
        </p>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label mb-1.5 block text-[12px]">{label}</span>
      {children}
    </label>
  );
}

function ImagePicker({
  preview,
  onFile,
}: {
  preview: string | null;
  onFile: (f: File) => void;
}) {
  return (
    <label className="panel grid h-[104px] w-[104px] cursor-pointer place-items-center overflow-hidden text-center">
      {preview ? (
        // A local data URL, so next/image would only add indirection.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="px-2 text-[12px] leading-tight text-muted">Add logo</span>
      )}
      <input
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

// --- Economics ------------------------------------------------------------------------------------

function Economics({ config, fees }: { config: LaunchpadConfig; fees: FeeBreakdown }) {
  const rows: [string, string, string][] = [
    ["Creator", `${fees.creatorPct.toFixed(2)}%`, "Yours, claimable at any time"],
    ["Corwa cashback", `${fees.referralPct.toFixed(2)}%`, "Referral share, rebated to users"],
    ["Treasury", `${fees.treasuryPct.toFixed(2)}%`, "MomoSwap protocol"],
    ["Buyback", `${fees.buybackPct.toFixed(2)}%`, "COOK bought back and burned"],
  ];

  return (
    <div className="card p-7">
      <h2 className="title text-primary">Where the {fees.totalPct.toFixed(0)}% trade fee goes</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        Percentages are of the trade, not of the fee. The referral slice is paid out of the same fee
        whether or not anyone is named - with no referrer, MomoSwap keeps it - so routing through
        Corwa costs a trader nothing and funds the rebate.
      </p>

      <dl className="mt-5 divide-y divide-[color:var(--divider)]">
        {rows.map(([label, pct, note]) => (
          <div key={label} className="flex items-baseline gap-4 py-3">
            <dt className="w-36 shrink-0 text-[14px] text-primary">{label}</dt>
            <dd className="num w-16 shrink-0 text-[14px] text-primary">{pct}</dd>
            <dd className="text-[13px] text-muted">{note}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="Launch cost" value={Number(config.creationFeeLamports) === 0 ? "Free" : "—"} />
        <Mini label="Supply" value={amount(Number(config.defaultTotalSupply) / 10 ** config.defaultTokenDecimals, 0)} />
        <Mini
          label="Graduates at"
          value={`${amount(Number(config.graduationTarget) / 1e9, 0)} COOK`}
        />
        <Mini label="Creator vest" value={`${config.creatorVestBps / 100}%`} />
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="label text-[12px]">{label}</div>
      <div className="num mt-1 text-[15px] text-primary">{value}</div>
    </div>
  );
}

// --- Pools ----------------------------------------------------------------------------------------

function LivePools({ pools }: { pools: (LaunchpadPool & { progress: number })[] }) {
  return (
    <div className="card p-7">
      <h2 className="title text-primary">On the curve</h2>
      <p className="mt-1.5 text-[13px] text-muted">
        Pools still climbing toward graduation.
      </p>

      {pools.length === 0 ? (
        <div className="panel mt-5 p-6 text-[13px] leading-relaxed text-muted">
          No pools are open right now. Cookie Chain&apos;s launchpad is early - the reserve of
          pre-ground mints is stocked and launching is free, so this is a page waiting for its first
          token rather than a broken feed.
        </div>
      ) : (
        <ul className="mt-5 space-y-2.5">
          {pools.slice(0, 12).map((p) => (
            <li key={p.pubkey} className="panel p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[14px] text-primary">
                    {p.name} <span className="text-subtle">{p.symbol}</span>
                  </div>
                  <div className="num mt-0.5 text-[12px] text-muted">
                    {usd(Number(p.paymentRaisedNet) / 1e9)} raised · {p.participantCount} holders
                  </div>
                </div>
                <span className="pill pill-quiet shrink-0">{p.status}</span>
              </div>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-[color:var(--surface-sunken)]">
                <div
                  className="h-full rounded-full bg-[var(--color-cookie)]"
                  style={{ width: `${Math.round(p.progress * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
