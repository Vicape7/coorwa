"use client";

/**
 * Wallet wiring.
 *
 * Cookie Chain is an SVM fork, so any Solana wallet signs for it - the only thing that differs is
 * the RPC the connection points at. Wallets that implement the Solana Wallet Standard (Nightly,
 * Backpack, Solflare, Phantom) register themselves, so no adapter list is needed here.
 *
 * Note there are two chains in play: this provider is the COOKIE CHAIN connection, which is what
 * the terminal, launchpad and pools sign against. The Solana leg of a cross-chain route uses its
 * own connection, created on demand in the route executor.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { COOKIE_RPC_URL } from "@/lib/config";

import "@solana/wallet-adapter-react-ui/styles.css";

/** Wallets that sign on Cookie Chain, offered when the browser has none. */
const WALLETS = [
  { name: "Nightly", url: "https://nightly.app" },
  { name: "Backpack", url: "https://backpack.app" },
  { name: "Phantom", url: "https://phantom.com" },
  { name: "Solflare", url: "https://solflare.com" },
];

export function WalletProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => COOKIE_RPC_URL, []);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * Replaces the adapter's own modal, which says "on Solana" on a Cookie Chain site, puts wallet names
 * in white on our light glass, and shows nothing to click when the browser has no wallet.
 */
function WalletModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const { wallets } = useWallet();

  // Still inside the tap that asked for a wallet, so the phone lets the link open the Nightly app.
  const show = useCallback(
    (open: boolean) => {
      if (open && isPhone() && usable(wallets).length === 0) window.location.href = nightlyLink();
      setVisible(open);
    },
    [wallets],
  );

  return (
    <WalletModalContext.Provider value={{ visible, setVisible: show }}>
      {children}
      {visible && <ConnectDialog onClose={() => setVisible(false)} />}
    </WalletModalContext.Provider>
  );
}

/**
 * Android Chrome adds the Mobile Wallet Adapter, which only opens the system's own list of every
 * Solana wallet on the phone. Coorwa sends a phone to Nightly instead, so that entry is left out.
 */
const MOBILE_ADAPTERS = new Set(["Mobile Wallet Adapter", "Remote Mobile Wallet Adapter"]);

function usable(wallets: ReturnType<typeof useWallet>["wallets"]) {
  return wallets.filter(
    (w) =>
      !MOBILE_ADAPTERS.has(w.adapter.name) &&
      (w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable),
  );
}

function isPhone() {
  if (typeof navigator === "undefined") return false;
  // iPadOS reports itself as a Mac, and only its touch points give it away.
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Nightly's universal link opens this page in the app's own browser, where the wallet is injected.
 * Without the app installed, the same link shows Nightly's page with the download buttons.
 */
function nightlyLink() {
  const url = encodeURIComponent(window.location.href);
  return `https://nightly.app/v1?network=solana&cluster=mainnet&url=${url}`;
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const { wallets, select } = useWallet();
  const found = usable(wallets);
  const phone = isPhone();

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-5">
      {/* The scrim is a sibling, not the parent: a blurred parent would leave the dialog's own
          glass nothing to blur. */}
      <div aria-hidden className="glass-scrim absolute inset-0" onClick={onClose} />
      <div
        className="glass-dialog relative w-full max-w-sm p-5 sm:p-7"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
      >
        <div className="flex items-start gap-3">
          <h3 id="connect-title" className="title min-w-0 flex-1 text-primary">
            {found.length ? "Connect a wallet" : phone ? "Opening Nightly" : "No wallet found"}
          </h3>
          <button className="btn btn-quiet btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {found.length ? (
          <ul className="mt-5 space-y-2">
            {found.map((w) => (
              <li key={w.adapter.name}>
                <button
                  className="btn btn-ghost w-full justify-start gap-3"
                  onClick={() => {
                    // autoConnect on the provider connects as soon as a wallet is selected.
                    select(w.adapter.name);
                    onClose();
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own data URI */}
                  <img src={w.adapter.icon} alt="" width={24} height={24} className="rounded-md" />
                  <span className="flex-1 text-left">{w.adapter.name}</span>
                  <span className="text-[12px] text-muted">Detected</span>
                </button>
              </li>
            ))}
          </ul>
        ) : phone ? (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              On a phone, Coorwa opens inside the Nightly app, where your wallet connects. If
              Nightly is not installed, the link takes you to its download page.
            </p>
            <div className="mt-5 grid gap-2">
              <a href={nightlyLink()} className="btn btn-primary w-full">
                Open in Nightly
              </a>
              <a
                href="https://nightly.app/download?tab=mobile"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost w-full"
              >
                Get Nightly
              </a>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Coorwa works with any Solana wallet, since Cookie Chain uses the same addresses.
              Install one as a browser extension, then reload this page.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              {WALLETS.map((w) => (
                <a
                  key={w.name}
                  href={w.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost w-full"
                >
                  {w.name}
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
