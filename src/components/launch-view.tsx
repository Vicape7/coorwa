"use client";

/**
 * Launchpad. Creating a pool is signature-gated by MomoSwap, so the flow is:
 * sign a login message (no chain fee, nothing submitted) -> build -> wallet signs the transaction.
 */
import { TokenMark } from "./token-mark";
import { useCallback, useState } from "react";
import useSWR from "swr";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { decodeTx, signSendConfirm, explainError } from "@/lib/tx";
import { verifyLaunchpadBuild } from "@/lib/expectation";
import { cookieTxUrl, COOKIE_EXPLORER, COOK_DECIMALS } from "@/lib/config";
import { shortAddr, amount, usd, uiToRaw } from "@/lib/format";
import { RWA_ASSETS, DEFAULT_RWA } from "@/lib/rwa";
import { Notice } from "./notice";
import { CurvePanel } from "./curve-panel";
import { CreatorLaunches } from "./creator-launches";
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
  const { data: poolsData } = useSWR<{
    pools: (LaunchpadPool & { progress: number })[];
    cookPriceUsd: number | null;
  }>("/api/launchpad/pools?status=all", fetcher, { refreshInterval: 20_000 });

  const [selected, setSelected] = useState<string | null>(null);

  const pools = poolsData?.pools ?? [];
  const trading = pools.find((p) => p.pubkey === selected) ?? null;

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Launchpad</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Launch a token on a COOK curve.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Coorwa builds on MomoSwap, Cookie Chain&apos;s bonding-curve launchpad. Your token trades
          on the curve until it hits the graduation target, then moves to a real DEX pool. It is a
          Coorwa pair from the start, priced in the stock you pick below.
        </p>
      </div>

      <div className="mt-10 grid gap-4 lg:grid-cols-[1fr_400px]">
        <div className="space-y-4">
          <CreateForm config={cfg?.config} />
          <CreatorLaunches pools={pools} cookPriceUsd={poolsData?.cookPriceUsd ?? null} />
          {cfg?.config && <Economics config={cfg.config} fees={cfg.fees} />}
        </div>

        <div className="space-y-4">
          {trading && (
            <CurvePanel
              pool={trading}
              decimals={cfg?.config.defaultTokenDecimals ?? 6}
              cookPriceUsd={poolsData?.cookPriceUsd ?? null}
              onClose={() => setSelected(null)}
            />
          )}
          <LivePools pools={pools} selected={selected} onSelect={setSelected} />
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
  const [benchmark, setBenchmark] = useState(DEFAULT_RWA.ticker);

  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    signature: string;
    mint?: string;
    ticker: string;
    /** False when the benchmark could not be stored, which quietly changes what the token is. */
    pinned: boolean;
  } | null>(null);

  const onFile = useCallback((file: File) => {
    if (file.size > 2_000_000) {
      setError("Image must be under 2 MB.");
      return;
    }
    // The same four the launchpad's pinning service is asked for, refused here so the message says
    // what to do rather than arriving as a rejected launch.
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
      setError("Logo must be a PNG, JPEG, GIF or WebP.");
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
      setError(
        "This wallet cannot sign messages, which the launchpad requires to authorise a launch.",
      );
      return;
    }
    setError(null);
    setDone(null);

    try {
      // 1. Session: sign a message. No chain fee, nothing submitted.
      setStep("Requesting a login nonce");
      const nonceRes = await fetch(`/api/launchpad/session?wallet=${publicKey.toBase58()}`).then(
        (r) => r.json(),
      );
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
      if (session.error) {
        throw new Error(session.hint ? `${session.error} - ${session.hint}` : session.error);
      }

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

      // 3. Check it is the launch asked for, with the same conversions the server made, then sign.
      await verifyLaunchpadBuild(built, {
        action: "create",
        wallet: publicKey.toBase58(),
        name,
        symbol: symbol.toUpperCase(),
        durationSecs: Math.round(durationHours * 3600),
        expiryMode: "fair",
        devBuyRaw: Number(devBuy) > 0 ? uiToRaw(Number(devBuy), COOK_DECIMALS) : null,
      });

      setStep("Confirm the launch in your wallet");
      const sent = await signSendConfirm(
        connection,
        decodeTx(built.transactionBase64),
        signTransaction,
      );

      // Pin the benchmark. The server proves the launch on chain before it writes anything, so this
      // can only ever record a token this wallet really created. If it fails the token still exists
      // and simply falls back to being quotable against every asset, which the notice says.
      let pinned = false;
      if (built.mint && built.pool) {
        pinned = await fetch("/api/launchpad/launches", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            signature: sent.signature,
            mint: built.mint,
            pool: built.pool,
            creator: publicKey.toBase58(),
            ticker: benchmark,
            symbol: symbol.toUpperCase(),
            name,
          }),
        })
          .then((r) => r.json())
          .then((r) => r.recorded === true)
          .catch(() => false);
      }

      setDone({ signature: sent.signature, mint: built.mint, ticker: benchmark, pinned });
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
    benchmark,
    connection,
  ]);

  const ready = name.trim().length > 0 && /^[A-Za-z0-9]{1,10}$/.test(symbol);
  const unavailable = config?.paused || config?.momoReady === 0;

  return (
    <div className="card p-5 sm:p-7">
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
                onChange={(e) =>
                  setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 10))
                }
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

        <Labeled label="Benchmark">
          <select
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
            className="field w-full cursor-pointer"
          >
            {RWA_ASSETS.map((a) => (
              <option key={a.ticker} value={a.ticker}>
                {a.ticker} · {a.name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[12px] leading-relaxed text-subtle">
            Your token trades as {symbol ? symbol.toUpperCase() : "TOKEN"}/{benchmark}, and its
            holders are paid their rewards in {benchmark}. It is the token&apos;s only pair and is
            fixed at launch, like the name. Liquidity is still the COOK curve, the way it is
            everywhere on this chain; the asset is what the price is quoted and charted in.
          </p>
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
          <Notice tone={done.pinned ? "up" : "note"}>
            Launched{done.pinned ? ` as ${done.ticker}` : ", but the benchmark was not saved"}.{" "}
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
          pool. Coorwa never holds your key and never co-signs.
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

function ImagePicker({ preview, onFile }: { preview: string | null; onFile: (f: File) => void }) {
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
    [
      "Coorwa rewards",
      `${fees.referralPct.toFixed(2)}%`,
      "Referral share, paid to the token's holders and creator",
    ],
    ["Treasury", `${fees.treasuryPct.toFixed(2)}%`, "MomoSwap protocol"],
    ["Buyback", `${fees.buybackPct.toFixed(2)}%`, "COOK bought back and burned"],
  ];

  return (
    <div className="card p-5 sm:p-7">
      <h2 className="title text-primary">Where the {fees.totalPct.toFixed(0)}% trade fee goes</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        Percentages are of the trade, not of the fee. The referral slice is paid out of the same fee
        whether or not anyone is named, and with no referrer MomoSwap keeps it. So routing through
        Coorwa costs a trader nothing, and the slice goes to the token&apos;s holders and creator.
      </p>

      <dl className="mt-5 divide-y divide-[color:var(--divider)]">
        {rows.map(([label, pct, note]) => (
          <div key={label} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-3">
            <dt className="flex-1 text-[14px] text-primary sm:w-36 sm:flex-none">{label}</dt>
            <dd className="num shrink-0 text-[14px] text-primary sm:w-16">{pct}</dd>
            <dd className="w-full text-[13px] text-muted sm:w-auto sm:flex-1">{note}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="Launch cost" value={Number(config.creationFeeLamports) === 0 ? "Free" : "—"} />
        <Mini
          label="Supply"
          value={amount(Number(config.defaultTotalSupply) / 10 ** config.defaultTokenDecimals, 0)}
        />
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

function LivePools({
  pools,
  selected,
  onSelect,
}: {
  pools: (LaunchpadPool & { progress: number })[];
  selected: string | null;
  onSelect: (pubkey: string | null) => void;
}) {
  return (
    <div className="card p-5 sm:p-7">
      <h2 className="title text-primary">On the curve</h2>
      <p className="mt-1.5 text-[13px] text-muted">
        Pools climbing toward graduation. Pick one to trade it.
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
            <li key={p.pubkey}>
              <button
                onClick={() => onSelect(selected === p.pubkey ? null : p.pubkey)}
                data-active={selected === p.pubkey}
                className="panel w-full p-4 text-left transition-colors data-[active=true]:border-[color:var(--color-cookie)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <TokenMark logo={p.logo ?? null} symbol={p.symbol} size={36} />
                  <div className="min-w-0 flex-1">
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
