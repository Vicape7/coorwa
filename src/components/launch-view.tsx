"use client";

/**
 * Launch a token on Coorwa's own curve.
 *
 * Nothing here is built by a server. The mint is a keypair made in this page, the instructions come
 * from `launch-program.ts`, and the only request that leaves before the wallet is asked is the one
 * that stores the token's metadata. So there is no build to verify against an expectation the way
 * the launchpad's flow needed: what the wallet signs is what this page assembled, in the open.
 *
 * What a creator picks here is permanent. The tax is written into the mint and cannot be changed by
 * anyone afterwards, the pair is the token's only pair, and the metadata freezes the moment the
 * launch lands. The copy says so at every step rather than once at the bottom.
 */
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { signSendConfirm, explainError } from "@/lib/tx";
import { cookieTxUrl, COOK_DECIMALS } from "@/lib/config";
import { shortAddr, amount, uiToRaw } from "@/lib/format";
import { RWA_ASSETS, DEFAULT_RWA } from "@/lib/rwa";
import {
  curvePda,
  fetchCurves,
  fetchLaunchConfig,
  type CurveState,
  type LaunchConfigState,
} from "@/lib/launch-program";
import { hasWrappedAccount, planLaunch, quoteDevBuy } from "@/lib/launch-flow";
import { metadataMessage } from "@/lib/launch-metadata";
import {
  clearUnrecorded,
  postRecord,
  saveUnrecorded,
  useUnrecorded,
} from "@/lib/unrecorded";
import { Notice } from "./notice";
import { TokenMark } from "./token-mark";
import { CreatorLaunches } from "./creator-launches";
import type { LaunchpadPool } from "@/lib/launchpad";

/** What POST /api/launchpad/launches takes for a launch on Coorwa's own program. */
interface LaunchReport {
  signature: string;
  mint: string;
  pool: string;
  creator: string;
  ticker: string;
  venue: "coorwa";
  symbol: string;
  name: string;
  logo?: string;
}

/** A dev buy is quoted off a curve nobody has traded yet, so only the creator's own buy moves it. */
const DEV_BUY_SLIPPAGE_BPS = 100n;

export function LaunchView() {
  const { connection } = useConnection();
  const { data: config, error } = useSWR(
    "launch/config",
    () => fetchLaunchConfig(connection),
    { refreshInterval: 60_000 },
  );

  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Launchpad</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          Launch a token that pays its holders.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.7] text-muted">
          Your token carries a tax on every transfer, and all of it goes to the people holding it,
          paid in the stock you pair it with. It trades on a COOK curve here from the first block
          and opens a locked pool when it graduates. Nothing about it can be changed afterwards,
          including by Coorwa.
        </p>
      </div>

      {config === null && (
        <Notice tone="down">
          The launch program is not configured on this chain yet, so launching is closed. Nothing
          else in the app is affected.
        </Notice>
      )}
      {error && <Notice tone="down">Could not read the launch program: {explainError(error)}</Notice>}

      <div className="mt-10 grid gap-4 lg:grid-cols-[1fr_400px]">
        <div className="space-y-4">
          <CreateForm config={config ?? null} />
          <YourLaunches config={config ?? null} />
          <OlderLaunches />
        </div>

        <div className="space-y-4">
          <Terms config={config ?? null} />
        </div>
      </div>
    </div>
  );
}

// --- Create ---------------------------------------------------------------------------------------

function CreateForm({ config }: { config: LaunchConfigState | null }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signMessage } = useWallet();
  const { setVisible } = useWalletModal();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageType, setImageType] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState(DEFAULT_RWA.ticker);
  const [taxBps, setTaxBps] = useState(100);
  const [devBuy, setDevBuy] = useState("");

  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    signature: string;
    mint: string;
    ticker: string;
    /** False when the pair could not be stored, which quietly changes what the token is. */
    pinned: boolean;
  } | null>(null);

  const waiting = useUnrecorded<LaunchReport>("launch");
  const wallet = publicKey?.toBase58() ?? null;
  const unrecorded = Object.values(waiting).filter((u) => u.body.creator === wallet);
  const [retrying, setRetrying] = useState(false);

  const tiers = useMemo(
    () => (config?.taxTiers ?? [100, 200, 300]).filter((t) => t > 0),
    [config],
  );
  // A config that drops a tier must not leave the form on one nobody can launch with, so the tier
  // in play is derived rather than stored: the picked one when it still exists, the first otherwise.
  const tax = tiers.includes(taxBps) ? taxBps : (tiers[0] ?? 100);

  const report = useCallback(async (body: LaunchReport): Promise<boolean> => {
    const res = await postRecord("/api/launchpad/launches", body);
    if (res.ok && res.data.recorded === true) {
      clearUnrecorded("launch", body.mint);
      return true;
    }
    if (!res.ok && !res.final) {
      saveUnrecorded("launch", body.mint, { body, error: res.error });
      return false;
    }
    clearUnrecorded("launch", body.mint);
    setError(res.ok ? "This deployment does not store pairs." : res.error);
    return false;
  }, []);

  const retry = useCallback(
    async (body: LaunchReport) => {
      setRetrying(true);
      setError(null);
      try {
        if (await report(body)) {
          setDone({ signature: body.signature, mint: body.mint, ticker: body.ticker, pinned: true });
        }
      } finally {
        setRetrying(false);
      }
    },
    [report],
  );

  const onFile = useCallback((file: File) => {
    if (file.size > 2_000_000) {
      setError("Image must be under 2 MB.");
      return;
    }
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

  const devBuyRaw = Number(devBuy) > 0 ? BigInt(uiToRaw(Number(devBuy), COOK_DECIMALS)) : 0n;

  /** What the creator's own buy would get them, priced on the curve their launch is about to open. */
  const preview = useMemo(() => {
    if (!config || devBuyRaw <= 0n || !publicKey) return null;
    return quoteDevBuy(
      config,
      { mint: PublicKey.default, creator: publicKey, taxBps: tax },
      devBuyRaw,
    );
  }, [config, devBuyRaw, publicKey, tax]);

  const launch = useCallback(async () => {
    if (!publicKey || !signTransaction || !config) return;
    if (!signMessage) {
      setError("This wallet cannot sign messages, which is how metadata is authorised.");
      return;
    }
    setError(null);
    setDone(null);

    const mint = Keypair.generate();
    const mintAddress = mint.publicKey.toBase58();

    try {
      // 1. Metadata. Signed for by the creator, named to this mint, and frozen once the launch
      //    lands, because the uri goes inside the mint and cannot be edited afterwards.
      setStep("Sign the metadata message in your wallet");
      const ts = Math.floor(Date.now() / 1000);
      const signature = await signMessage(
        new TextEncoder().encode(metadataMessage(publicKey.toBase58(), mintAddress, ts)),
      );

      setStep("Storing the metadata");
      const stored = await fetch("/api/launch/metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creator: publicKey.toBase58(),
          mint: mintAddress,
          ts,
          signature: bs58.encode(signature),
          name,
          symbol: symbol.toUpperCase(),
          description: description || undefined,
          imageBase64: imageBase64 ?? undefined,
          imageContentType: imageType ?? undefined,
          pair: benchmark,
        }),
      }).then((r) => r.json());
      if (stored.error) {
        throw new Error(stored.hint ? `${stored.error} - ${stored.hint}` : stored.error);
      }

      // 2. Build it here, in the page. A dev buy rides along when it fits.
      setStep("Building the launch");
      const quote =
        devBuyRaw > 0n
          ? quoteDevBuy(config, { mint: mint.publicKey, creator: publicKey, taxBps: tax }, devBuyRaw)
          : null;
      const plan = planLaunch(
        {
          creator: publicKey,
          mint: mint.publicKey,
          name,
          symbol: symbol.toUpperCase(),
          uri: stored.uri,
          taxBps: tax,
          devBuyQuote: devBuyRaw,
          minBaseOut: quote
            ? (quote.baseOut * (10_000n - DEV_BUY_SLIPPAGE_BPS)) / 10_000n
            : 0n,
          closeWrapped: !(await hasWrappedAccount(connection, publicKey)),
        },
        (await connection.getLatestBlockhash("confirmed")).blockhash,
      );

      // The mint signs the transaction that creates it, and never signs again.
      plan.transactions[0].partialSign(mint);

      setStep("Confirm the launch in your wallet");
      const sent = await signSendConfirm(connection, plan.transactions[0], signTransaction);

      // A dev buy that did not fit goes out on its own. The token is live either way, so a failure
      // here is reported rather than thrown.
      let buyFailed: string | null = null;
      if (plan.split) {
        try {
          setStep("Confirm your buy at launch in your wallet");
          await signSendConfirm(connection, plan.transactions[1], signTransaction);
        } catch (e) {
          buyFailed = explainError(e);
        }
      }

      // 3. Record the pair. The server reads the launch back off the chain before it writes.
      const pinned = await report({
        signature: sent.signature,
        mint: mintAddress,
        pool: curvePda(mint.publicKey).toBase58(),
        creator: publicKey.toBase58(),
        ticker: benchmark,
        venue: "coorwa",
        symbol: symbol.toUpperCase(),
        name,
        logo: typeof stored.image === "string" ? stored.image : undefined,
      });

      setDone({ signature: sent.signature, mint: mintAddress, ticker: benchmark, pinned });
      if (buyFailed) setError(`The token is live, but your buy at launch did not: ${buyFailed}`);
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
    config,
    connection,
    name,
    symbol,
    description,
    imageBase64,
    imageType,
    benchmark,
    tax,
    devBuyRaw,
    report,
  ]);

  const ready = name.trim().length > 0 && /^[A-Za-z0-9]{1,10}$/.test(symbol);
  const supply = config ? config.saleBase + config.migrationBase : 0n;

  return (
    <div className="card p-5 sm:p-7">
      <h2 className="title text-primary">Create</h2>
      <p className="mt-1.5 text-[13px] text-muted">
        Everything on this form is permanent. The name, the picture, the tax and the pair are
        written into the token and nobody can edit them later.
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

        <Labeled label="Pair">
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
            holders are paid in {benchmark}. It is the token&apos;s only pair, fixed at launch.
            Liquidity is the COOK curve, the way it is everywhere on this chain; the stock is what
            the price is quoted in and what the tax is paid out as.
          </p>
        </Labeled>

        <Labeled label="Tax on every transfer">
          <div className="segmented w-full">
            {tiers.map((bps) => (
              <button
                key={bps}
                onClick={() => setTaxBps(bps)}
                data-active={tax === bps}
                className="flex-1"
              >
                {bps / 100}%
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-subtle">
            Taken on every transfer of your token, anywhere, and paid to the wallets holding it. A
            higher tax pays holders more and costs traders more. It is set once, here: the mint is
            created with no authority that could ever change it.
          </p>
        </Labeled>

        <Labeled label="Buy at launch (COOK, optional)">
          <input
            value={devBuy}
            onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0"
            className="field num w-full"
          />
          {preview && config && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-subtle">
              About {amount(Number(preview.baseReceived) / 10 ** config.tokenDecimals, 0)}{" "}
              {symbol ? symbol.toUpperCase() : "tokens"}, which is{" "}
              {((Number(preview.baseOut) / Number(supply)) * 100).toFixed(1)}% of the supply. You pay
              the tax on it like anyone else.
              {preview.graduates && " This buy alone graduates the curve."}
            </p>
          )}
        </Labeled>

        {step && <Notice tone="note">{step}</Notice>}
        {error && <Notice tone="down">{error}</Notice>}

        {done && (
          <Notice tone={done.pinned ? "up" : "note"}>
            Launched{done.pinned ? ` as ${done.ticker}` : ", but its pair was not saved"}. Mint{" "}
            <span className="num">{shortAddr(done.mint, 6)}</span>
            {" · "}
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

        {unrecorded.map((u) => (
          <Notice key={u.body.mint} tone="down">
            {u.body.symbol} launched (
            <a
              href={cookieTxUrl(u.body.signature)}
              target="_blank"
              rel="noreferrer"
              className="num underline underline-offset-4"
            >
              {shortAddr(u.body.signature, 6)}
            </a>
            ), but its pair with {u.body.ticker} was not saved: {u.error}. Until it is, the token is
            not a Coorwa pair. Try again reports the same launch; nothing is signed or paid.
            <span className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-primary" disabled={retrying} onClick={() => retry(u.body)}>
                {retrying ? "Saving the pair" : "Try again"}
              </button>
            </span>
          </Notice>
        ))}

        {!publicKey ? (
          <button className="btn btn-primary w-full" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        ) : (
          <button
            className="btn btn-primary w-full"
            disabled={!ready || !!step || !config || config.paused}
            onClick={launch}
          >
            {step ? "Working" : config?.paused ? "Launching is paused" : "Launch token"}
          </button>
        )}

        <p className="text-[12px] leading-relaxed text-subtle">
          Two signatures: a message that authorises your metadata, then the launch itself. The
          transaction is built in this page, not on a server, and Coorwa never holds your key.
        </p>
      </div>
    </div>
  );
}

// --- Your launches --------------------------------------------------------------------------------

function YourLaunches({ config }: { config: LaunchConfigState | null }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();

  const { data: curves } = useSWR(
    publicKey ? ["launch/curves", publicKey.toBase58()] : null,
    () => fetchCurves(connection, publicKey!),
    { refreshInterval: 30_000 },
  );

  if (!publicKey) return null;

  return (
    <div className="card p-5 sm:p-7">
      <h2 className="title text-primary">Your launches</h2>
      <p className="mt-1.5 text-[13px] text-muted">
        Tokens this wallet created on Coorwa&apos;s curve, read straight off the chain.
      </p>

      {!curves ? (
        <div className="skeleton mt-5 h-20 rounded-2xl" />
      ) : curves.length === 0 ? (
        <div className="panel mt-5 p-6 text-[13px] leading-relaxed text-muted">
          Nothing yet. A token you launch here shows up in this list as soon as it lands, with how
          far its curve has come.
        </div>
      ) : (
        <ul className="mt-5 space-y-2.5">
          {curves.map((c) => (
            <CurveRow key={c.mint.toBase58()} curve={c} decimals={config?.tokenDecimals ?? 6} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A curve's name and picture.
 *
 * The curve account holds neither: the name lives on the mint and the picture behind the uri the
 * mint carries, which is this document. Read by the mint's own path rather than by the absolute uri
 * in it, so a token launched against a development server still shows itself.
 */
function useTokenMetadata(mint: string) {
  const { data } = useSWR<{ name?: string; symbol?: string; image?: string }>(
    `/t/${mint}`,
    (u: string) => fetch(u).then((r) => (r.ok ? r.json() : {})),
    { revalidateOnFocus: false },
  );
  return {
    name: data?.name ?? null,
    symbol: data?.symbol ?? null,
    // Ours is served from this origin whatever the document says; a creator's own url is used as it is.
    image: data?.image ? (data.image.includes(`/t/${mint}/image`) ? `/t/${mint}/image` : data.image) : null,
  };
}

function CurveRow({ curve, decimals }: { curve: CurveState; decimals: number }) {
  const progress =
    curve.graduationQuote > 0n
      ? Number((curve.quoteRaised * 1000n) / curve.graduationQuote) / 1000
      : 0;
  const mint = curve.mint.toBase58();
  const token = useTokenMetadata(mint);

  return (
    <li className="panel p-4">
      <div className="flex items-center gap-3">
        <TokenMark logo={token.image} symbol={token.symbol ?? mint.slice(0, 4)} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-primary">
            {token.name ?? shortAddr(mint, 6)}{" "}
            {token.symbol && <span className="text-subtle">{token.symbol}</span>}
          </div>
          <div className="num mt-0.5 text-[12px] text-muted">
            {amount(Number(curve.quoteRaised) / 10 ** COOK_DECIMALS, 0)} of{" "}
            {amount(Number(curve.graduationQuote) / 10 ** COOK_DECIMALS, 0)} COOK ·{" "}
            {curve.taxBps / 100}% tax
          </div>
        </div>
        <span className="pill pill-quiet shrink-0">{curve.state}</span>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-[color:var(--surface-sunken)]">
        <div
          className="h-full rounded-full bg-[var(--color-cookie)]"
          style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
        />
      </div>
      <div className="num mt-2 text-[12px] text-subtle">
        {amount(Number(curve.baseSold) / 10 ** decimals, 0)} tokens sold
      </div>
    </li>
  );
}

/**
 * Tokens this wallet launched on the MomoSwap curve, back when that was the only way.
 *
 * Launching there is closed now, but the fees those curves earned their creator are still theirs
 * and are still claimed with their own key, so the panel stays. It renders nothing for a wallet
 * that never launched one, which is nearly everyone.
 */
function OlderLaunches() {
  const { publicKey } = useWallet();
  const { data } = useSWR<{
    pools: LaunchpadPool[];
    cookPriceUsd: number | null;
  }>(publicKey ? "/api/launchpad/pools?status=all" : null, (u: string) =>
    fetch(u).then((r) => r.json()),
  );

  return (
    <CreatorLaunches pools={data?.pools ?? []} cookPriceUsd={data?.cookPriceUsd ?? null} />
  );
}

// --- Terms ----------------------------------------------------------------------------------------

function Terms({ config }: { config: LaunchConfigState | null }) {
  const supply = config ? config.saleBase + config.migrationBase : 0n;
  const decimals = config?.tokenDecimals ?? 6;

  return (
    <div className="card p-5 sm:p-7">
      <h2 className="title text-primary">What a launch promises</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        Read from the program itself, not from this page. Every token launched here gets the same
        deal.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Mini
          label="Supply"
          value={config ? amount(Number(supply) / 10 ** decimals, 0) : "—"}
        />
        <Mini
          label="Graduates at"
          value={
            config
              ? `${amount(Number(config.graduationQuote) / 10 ** COOK_DECIMALS, 0)} COOK`
              : "—"
          }
        />
        <Mini label="Launch cost" value="Free" />
        <Mini
          label="Curve fee"
          value={config ? `${config.curveFeeBps / 100}%` : "—"}
        />
      </div>

      <dl className="mt-5 divide-y divide-[color:var(--divider)]">
        <Term label="The tax">
          All of it goes to the wallets holding your token, paid daily in the stock you paired it
          with. Coorwa keeps none of it and neither do you, unless you hold your own token.
        </Term>
        <Term label="On the curve">
          {config ? `${config.curveFeeBps / 100}%` : "1%"} of each trade goes to Coorwa, and
          Coorwa&apos;s own terminal fee is dropped for these tokens so no trade is charged twice.
        </Term>
        <Term label="At graduation">
          The program opens a Cookiebox pool itself, locks the liquidity in it permanently and burns
          whatever the curve did not sell. Nobody can pull that liquidity out, including Coorwa.
        </Term>
        <Term label="After that">
          The locked position earns fees on every trade in the pool.{" "}
          {config ? `${config.creatorLpShareBps / 100}%` : "40%"} of them are yours, for as long as
          the pool exists.
        </Term>
        <Term label="What Coorwa can do">
          It can pause new launches and it holds the authority to upgrade the program, which will be
          given up once it has run quietly for a while. It can never touch a token that exists: no
          mint authority, no freeze authority, no way to change a tax or unlock a pool.
        </Term>
      </dl>
    </div>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3.5 first:pt-0 last:pb-0">
      <dt className="text-[13px] text-primary">{label}</dt>
      <dd className="mt-1 text-[13px] leading-[1.7] text-muted">{children}</dd>
    </div>
  );
}

// --- small pieces ---------------------------------------------------------------------------------

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

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="label text-[12px]">{label}</div>
      <div className="num mt-1 text-[15px] text-primary">{value}</div>
    </div>
  );
}
