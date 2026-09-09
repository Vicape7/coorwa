"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./wallet-button";

const LINKS = [
  { href: "/terminal", label: "Terminal" },
  { href: "/launch", label: "Launch" },
  { href: "/pools", label: "Pools" },
  { href: "/rewards", label: "Rewards" },
];

/**
 * Header. The nav group is centred and the wallet sits at the right edge, which keeps the bar calm
 * at any width — the same arrangement Pons uses.
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <header className="glass sticky top-0 z-40">
      <div className="relative mx-auto flex h-16 max-w-[1400px] items-center px-5">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-cookie)] text-[13px]">
            🍪
          </span>
          <span className="title text-primary">corwa</span>
        </Link>

        {/* Centred on wide screens, so the bar reads as a single balanced object. */}
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full bg-[var(--surface-raised)] p-1 lg:flex">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={
                  active
                    ? "rounded-full bg-[var(--surface)] px-4 py-2 text-[13px] font-medium text-primary shadow-[var(--shadow-card)]"
                    : "rounded-full px-4 py-2 text-[13px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
                }
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ChainDot />
          <WalletButton />
        </div>
      </div>

      <nav className="flex items-center gap-1.5 overflow-x-auto px-5 pb-3 lg:hidden">
        {LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={active ? "pill pill-active shrink-0" : "pill pill-quiet shrink-0"}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function ChainDot() {
  return (
    <Link
      href="/status"
      title="Cookie Chain status"
      className="pill pill-quiet hidden transition-colors hover:text-[color:var(--text-primary)] sm:inline-flex"
    >
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--color-up)]" />
      Cookie Chain
    </Link>
  );
}
