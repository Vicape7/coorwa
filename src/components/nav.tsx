"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";
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
 *
 * The links sit in `.nav-well`, a lighter film with its own rim, so they read as a channel in the
 * glass rather than a grey tray laid on top of it. On the right, the theme switch and Connect, both
 * at the height of the well.
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
      <div className="glass glass-bar mx-auto flex max-w-[1240px] items-center gap-3 rounded-full py-2 pl-3 pr-2 shadow-[var(--shadow-soft)] sm:pl-4">
        <Brand />

        <nav className="nav-well ml-1 hidden items-center gap-0.5 rounded-full p-1 lg:flex">
          {LINKS.map((l) => (
            <NavLink key={l.href} {...l} pathname={pathname} />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>

      {/*
       * Below lg the links live in a glass tab bar at the bottom of the screen, where a thumb reaches
       * them. As a second row under the island they scrolled over the page with nothing behind the
       * text, and the sticky header took a sixth of a phone screen.
       */}
      <nav
        aria-label="Sections"
        className="fixed inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] z-40 lg:hidden"
      >
        <div className="glass glass-bar mx-auto flex max-w-[480px] items-center gap-1 rounded-full p-1.5 shadow-[var(--shadow-soft)]">
          {LINKS.map((l) => {
            const active = isActive(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "nav-chip flex-1 rounded-full py-2.5 text-center text-[13px] font-medium text-primary"
                    : "flex-1 rounded-full py-2.5 text-center text-[13px] text-muted"
                }
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}

function Brand() {
  return (
    // The mark alone, no wordmark beside it. The full logo now carries the name in the hero, and
    // repeating it 40px above that read as two logos rather than one brand.
    <Link href="/" className="flex shrink-0 items-center" aria-label="Coorwa home">
      <Image
        src="/coorwa.png"
        alt=""
        width={512}
        height={512}
        priority
        className="h-8 w-8 object-contain drop-shadow-[0_1px_3px_rgba(120,64,24,0.28)]"
      />
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
          ? "nav-chip rounded-full px-4 py-2 text-[13px] font-medium text-primary"
          : "rounded-full px-4 py-2 text-[13px] text-muted transition-colors hover:text-[color:var(--text-primary)]"
      }
    >
      {label}
    </Link>
  );
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}
