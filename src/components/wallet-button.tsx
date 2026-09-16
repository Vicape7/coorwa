"use client";

/**
 * Connect button.
 *
 * Cookie Chain is an SVM fork, so a Solana wallet signs for it unchanged - but the balance shown
 * here is COOK read from the Cookie Chain RPC, not SOL.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { shortAddr, amount } from "@/lib/format";
import { COOK_DECIMALS } from "@/lib/config";

export function WalletButton() {
  const { publicKey, disconnect, connecting, wallet } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const [balance, setBalance] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Where the menu opens, in viewport pixels, measured from the button. */
  const [spot, setSpot] = useState<{ top: number; right: number } | null>(null);

  // A disconnected wallet has no balance to show, so that case is derived at render rather than
  // written back into state - the effect only ever reports what the RPC said.
  const shownBalance = publicKey ? balance : null;

  useEffect(() => {
    if (!publicKey) return;
    let alive = true;
    const read = () =>
      connection
        .getBalance(publicKey)
        .then((l) => alive && setBalance(l / 10 ** COOK_DECIMALS))
        .catch(() => alive && setBalance(null));
    read();
    const id = setInterval(read, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [publicKey, connection]);

  // Dismiss the menu on an outside click, the way a native popover behaves.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!holder.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /*
   * The menu is portalled to <body> and placed with `position: fixed`. Inside the nav island it
   * could not be glass: the island has its own backdrop-filter, which makes it the backdrop root, so
   * the menu's blur saw an empty layer and the page text showed straight through it.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = holder.current?.getBoundingClientRect();
      if (r) setSpot({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const onClick = useCallback(() => {
    if (publicKey) setOpen((v) => !v);
    else setVisible(true);
  }, [publicKey, setVisible]);

  if (!publicKey) {
    return (
      <button onClick={onClick} disabled={connecting} className="btn btn-primary btn-nav">
        {connecting ? "Connecting" : "Connect"}
      </button>
    );
  }

  return (
    <div className="relative" ref={holder}>
      <button onClick={onClick} className="btn btn-ghost btn-nav">
        <span className="num">{amount(shownBalance ?? 0, 2)} COOK</span>
        <span className="text-subtle">·</span>
        <span className="num">{shortAddr(publicKey.toBase58())}</span>
      </button>

      {open &&
        spot &&
        createPortal(
          <div
            ref={menu}
            className="glass-dialog fixed z-50 w-64 max-w-[calc(100vw-16px)] overflow-hidden p-1"
            style={{ top: spot.top, right: spot.right }}
          >
            <div className="px-3 py-2.5">
              <div className="label">{wallet?.adapter.name ?? "Wallet"}</div>
              <div className="num mt-1 break-all text-[11px] text-muted">
                {publicKey.toBase58()}
              </div>
            </div>
            <button
              className="w-full rounded-2xl px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-raised"
              onClick={() => {
                navigator.clipboard?.writeText(publicKey.toBase58());
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
            <button
              className="w-full rounded-2xl px-3 py-2.5 text-left text-[13px] text-[color:var(--color-down)] transition-colors hover:bg-raised"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
