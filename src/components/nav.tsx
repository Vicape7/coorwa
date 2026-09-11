"use client";

import Image from "next/image";
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
 * A floating island rather than a full-width bar - the arrangement Pons uses, and the one that
 * lets the page tint run behind the header instead of stopping at it.
 *
 * `.glass` plus `.glass-bar` rather than `.glass-pane`: the pane's pseudo-element machinery buys
 * nothing on a pill this shallow, but the bar lens does. This is the one surface with a whole page
 * scrolling underneath it, so it is where the refraction is actually visible - the pills below keep
 * plain `.glass`, since a lens on something 32px tall is cost without a picture.
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
      <div className="glass glass-bar mx-auto flex max-w-[1240px] items-center gap-3 rounded-full py-2 pl-3 pr-2 shadow-[var(--shadow-soft)] sm:pl-4">
        <Brand />

        <nav className="ml-1 hidden items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--surface-raised)_72%,transparent)] p-1 lg:flex">
          {LINKS.map((l) => (
            <NavLink key={l.href} {...l} pathname={pathname} />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ChainDot />
          <WalletButton />
        </div>
      </div>

      {/* Below lg the links move to their own scrollable row so the island never wraps. */}
      <nav className="mx-auto mt-2 flex max-w-[1240px] items-center gap-1.5 overflow-x-auto pb-1 lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {LINKS.map((l) => {
          const active = isActive(pathname, l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={active ? "pill pill-active shrink-0" : "pill glass shrink-0"}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Corwa home">
      <Image
        src="/corwa.png"
        alt=""
        width={512}
        height={512}
        priority
        className="h-7 w-7 object-contain drop-shadow-[0_1px_3px_rgba(120,64,24,0.28)]"
      />
      <span className="title text-primary">corwa</span>
    </Link>
  );
}

function NavLink({ href, label, pathname }: { href: string; label: string; pathname: string }) {
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full bg-[var(--surface)] px-4 py-2 text-[13px] font-medium text-primary shadow-[var(--shadow-card)]"
          : "rounded-full px-4 py-2 text-[13px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
      }
    >
      {label}
    </Link>
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

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}
