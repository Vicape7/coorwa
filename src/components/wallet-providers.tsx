"use client";

/**
 * Wallet wiring.
 *
 * Cookie Chain is an SVM fork, so any Solana wallet signs for it — the only thing that differs is
 * the RPC the connection points at. Wallets that implement the Solana Wallet Standard (Nightly,
 * Backpack, Solflare, Phantom) register themselves, so no adapter list is needed here.
 *
 * Note there are two chains in play: this provider is the COOKIE CHAIN connection, which is what
 * the terminal, launchpad and pools sign against. The Solana leg of a cross-chain route uses its
 * own connection, created on demand in the route executor.
 */
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { COOKIE_RPC_URL } from "@/lib/config";

import "@solana/wallet-adapter-react-ui/styles.css";

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
