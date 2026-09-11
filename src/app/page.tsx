import Link from "next/link";
import { Nav } from "@/components/nav";
import { HeroSearch } from "@/components/hero-search";
import { LiveStats } from "@/components/live-stats";
import { RwaCarousel } from "@/components/rwa-carousel";
import { AuroraField, GlassEffect } from "@/components/ui/liquid-glass";
import { GradientWave } from "@/components/ui/gradient-wave";

export default function Home() {
  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Cheap gradient field for everything below the fold, so the lower glass still has a backdrop. */}
      <AuroraField />

      {/*
       * The hero's own backdrop: slow amber waves in WebGL. This is what the glass is for - a pane
       * over a flat page is a translucent card no matter how it is lit, and the whole lensing chain
       * has nothing to show until something behind it actually moves.
       *
       * Masked out over its bottom half rather than cut off, and it sits behind the sticky header
       * so the nav is glass over the field rather than glass over paper.
       */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[980px] overflow-hidden"
        style={{
          maskImage: "linear-gradient(180deg, #000 0%, #000 52%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(180deg, #000 0%, #000 52%, transparent 100%)",
        }}
      >
        <GradientWave className="h-full w-full" />
      </div>

      <Nav />

      <section className="mx-auto w-full max-w-[1160px] px-5 pb-20 pt-2 text-center sm:pt-4">
        {/* The sixteen benchmarks, as objects rather than a list. This is the hero's argument. */}
        <div className="rise">
          <RwaCarousel />
        </div>

        <h1 className="display rise mx-auto -mt-6 max-w-[15ch] text-[clamp(2.5rem,6.4vw,4.25rem)] text-primary sm:-mt-10">
          Trade Cookie Chain in RWAs.
        </h1>

        <div className="rise mt-9">
          <HeroSearch />
        </div>

        <div className="rise mt-5 flex flex-wrap items-center justify-center gap-2">
          <Link href="/launch" className="btn btn-ghost btn-sm">
            Launch a token
          </Link>
          <Link href="/pools" className="btn btn-quiet btn-sm">
            Make a market
          </Link>
        </div>

        <div className="rise mt-14 text-left">
          <LiveStats />
        </div>
      </section>

      <Section>
        <div className="grid gap-3 md:grid-cols-3">
          <Tool
            href="/terminal"
            title="Terminal"
            body="Candles built from executed fills, not standing quotes. Both Cookie Chain routers quoted on every trade; the better fill wins."
          />
          <Tool
            href="/launch"
            title="Launchpad"
            body="Mint on a COOK bonding curve through MomoSwap. The fee split is read from the live config, never hardcoded."
          />
          <Tool
            href="/pools"
            title="LP maker"
            body="Cookiebox DAMM v2 positions managed natively - deposit, claim, withdraw - against the fork's own program and IDL."
          />
        </div>
      </Section>

      {/* The single claim the whole product rests on. Everything else about it is in the README. */}
      <Section>
        <GlassEffect refract="deep" className="rounded-[var(--radius-float)] p-8 sm:p-12">
          <span className="label text-[12px]">The honest version</span>
          <h2 className="display mt-3 max-w-[28ch] text-[clamp(1.75rem,3.4vw,2.4rem)] text-primary">
            There is no TOKEN/NVDA pool.
          </h2>
          <p className="mt-5 max-w-[62ch] text-[15px] leading-[1.7] text-muted">
            And Coorwa will not pretend there is. xStocks live only on Solana, and Cookie
            Chain&apos;s bridge carries COOK alone. So a pair here is a{" "}
            <span className="text-primary">denomination</span> - two live market prices divided:
          </p>

          <div className="num mt-6 inline-block rounded-full bg-[color-mix(in_srgb,var(--surface-raised)_78%,transparent)] px-5 py-3 text-[15px] text-primary">
            price(TOKEN in NVDA) = usd(TOKEN) &divide; usd(NVDAx)
          </div>

          <p className="mt-6 max-w-[62ch] text-[15px] leading-[1.7] text-muted">
            The numerator is real reserves in a Cookie Chain pool; the denominator is real Solana
            liquidity. Neither is modelled, so the ratio is exact - a change of units, not a
            synthetic instrument. Want the actual share instead? Coorwa routes you cross-chain and
            it lands in <span className="text-primary">your own Solana wallet</span>.
          </p>
        </GlassEffect>
      </Section>

      <Section>
        <div className="grid gap-3 sm:grid-cols-3">
          <Split pct="50" who="Traders" />
          <Split pct="30" who="Creators" />
          <Split pct="20" who="Liquidity" />
        </div>
        <p className="mt-6 max-w-[70ch] text-[14px] leading-[1.7] text-muted">
          <span className="text-primary">Where the money is from.</span> MomoSwap pays a referrer
          20% of its 1% curve fee, out of the same fee either way - with nobody named, the programme
          keeps that slice itself. So Coorwa naming itself costs a trader nothing. Swaps are a
          different story: neither Cookie Chain router exposes a platform fee yet, so those fills
          earn Coorwa nothing and are recorded at zero rather than credited with a rebate no fee is
          backing.{" "}
          <Link href="/rewards" className="text-primary underline underline-offset-4">
            See your cashback
          </Link>
          .
        </p>
      </Section>

      <footer className="mx-auto mt-auto w-full max-w-[1160px] px-5 pb-12 pt-6">
        <div className="flex flex-wrap items-center gap-x-7 gap-y-3 text-[14px] text-muted">
          <span className="title text-primary">coorwa</span>
          <span>Built on Cookie Chain.</span>
          <div className="ml-auto flex flex-wrap gap-6">
            <FooterLink href="https://www.cookiechain.wtf">Cookie Chain</FooterLink>
            <FooterLink href="https://cookiescan.io">Explorer</FooterLink>
            <Link
              href="/status"
              className="transition-colors hover:text-[color:var(--text-primary)]"
            >
              Status
            </Link>
          </div>
        </div>
        <p className="mt-5 max-w-[80ch] text-[12px] leading-[1.7] text-subtle">
          Coorwa is a non-custodial interface. It never holds your assets and never signs for you.
          Tokens on Cookie Chain are volatile and can lose all value; tokenised equities carry
          issuer and transfer-restriction risk of their own. Nothing here is investment advice.
        </p>
      </footer>
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto w-full max-w-[1160px] px-5 py-7">{children}</section>;
}

function Tool({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <GlassEffect href={href} className="group flex flex-col rounded-[var(--radius-float)] p-7">
      <h3 className="title text-primary">{title}</h3>
      <p className="mt-3 flex-1 text-[14px] leading-[1.7] text-muted">{body}</p>
      <span className="mt-7 inline-flex items-center gap-1.5 text-[13px] font-medium text-primary">
        Open
        <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
      </span>
    </GlassEffect>
  );
}

function Split({ pct, who }: { pct: string; who: string }) {
  return (
    <GlassEffect className="rounded-[var(--radius-float)] px-7 py-6">
      <div className="num display text-[52px] leading-none text-primary">
        {pct}
        <span className="text-[24px] text-subtle">%</span>
      </div>
      <div className="mt-3 text-[15px] font-medium text-primary">{who}</div>
    </GlassEffect>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="transition-colors hover:text-[color:var(--text-primary)]"
    >
      {children}
    </a>
  );
}
