import Image from "next/image";
import Link from "next/link";
import wordmark from "../../public/coorwa-wordmark.webp";

const LINKS: { label: string; href: string }[] = [
  { label: "Terminal", href: "/terminal" },
  { label: "Launch", href: "/launch" },
  { label: "Rewards", href: "/rewards" },
  { label: "Roadmap", href: "/roadmap" },
  { label: "Status", href: "/status" },
  { label: "Explorer", href: "https://cookiescan.io" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "Risks", href: "/risks" },
];

const SOCIALS = [
  {
    label: "GitHub",
    href: "https://github.com/Vicape7",
    path: "M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z",
  },
  {
    label: "X",
    href: "https://x.com/coorwadotfun",
    path: "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64Z",
  },
];

/** The footer every page ends on. */
export function SiteFooter() {
  return (
    <footer className="mx-auto mt-auto w-full max-w-[1160px] px-5 pb-8 pt-10">
      <div className="card px-5 py-5 sm:px-7">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <Link href="/" aria-label="Coorwa home" className="shrink-0">
            <Image
              src={wordmark}
              alt="Coorwa"
              sizes="120px"
              className="h-auto w-[120px] drop-shadow-[0_1px_3px_rgba(120,64,24,0.22)]"
            />
          </Link>

          {/* Last on a phone, where it wraps under the wordmark and the icons. */}
          <nav
            aria-label="Footer"
            className="order-last flex w-full flex-wrap gap-x-5 gap-y-2 lg:order-none lg:w-auto"
          >
            {LINKS.map((l) => (
              <FooterLink key={l.label} href={l.href}>
                {l.label}
              </FooterLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            {SOCIALS.map((s) => (
              <a
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noreferrer"
                aria-label={s.label}
                className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-raised hover:text-[color:var(--text-primary)]"
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
                  <path d={s.path} />
                </svg>
              </a>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 border-t border-hair pt-4 md:flex-row md:items-baseline md:justify-between md:gap-8">
          <p className="text-[12px] leading-[1.6] text-subtle">
            Tokens on Cookie Chain are volatile and can lose all their value. Rewards are not
            guaranteed. Nothing here is investment advice.
          </p>
          <span className="shrink-0 text-[12px] text-subtle">
            &copy; {new Date().getFullYear()} Coorwa
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  const className =
    "whitespace-nowrap text-[13px] text-muted transition-colors hover:text-[color:var(--text-primary)]";
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}
