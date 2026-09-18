import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import launchpadArt from "../../public/launchpad.webp";
import lpArt from "../../public/lp.webp";
import stocksArt from "../../public/stocks.webp";
import terminalArt from "../../public/terminal.webp";
import { Nav } from "@/components/nav";
import { HeroSearch } from "@/components/hero-search";
import { LiveStats } from "@/components/live-stats";
import { RewardsCalculator } from "@/components/rewards-calculator";
import { RwaCarousel } from "@/components/rwa-carousel";
import { SiteFooter } from "@/components/site-footer";
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
            image={terminalArt}
            body="Candles built from executed fills, not standing quotes. Both Cookie Chain routers quoted on every trade; the better fill wins."
          />
          <Tool
            href="/launch"
            title="Launchpad"
            image={launchpadArt}
            body="Mint on a COOK bonding curve through MomoSwap and pick its stock at launch. MomoSwap's fee split is read live."
          />
          <Tool
            href="/pools"
            title="LP maker"
            image={lpArt}
            body="Cookiebox DAMM v2 positions managed natively - deposit, claim, withdraw - against the fork's own program and IDL."
          />
        </div>
      </Section>

      {/* How a pair is priced: two live markets divided. The details are in the README. */}
      <Section>
        <GlassEffect refract="deep" className="rounded-[var(--radius-float)] p-8 sm:p-12">
          {/* Fills the empty right half on wide screens; below lg the text needs the whole width. */}
          <Image
            src={stocksArt}
            alt=""
            aria-hidden
            sizes="400px"
            className="pointer-events-none absolute right-6 top-1/2 z-0 hidden h-[400px] w-[400px] -translate-y-1/2 select-none lg:block xl:right-12"
          />
          <span className="label relative z-10 text-[12px]">How pricing works</span>
          <h2 className="display mt-3 text-[clamp(1.75rem,3.4vw,2.4rem)] text-primary">
            <span className="block">Priced in real stocks.</span>
            <span className="block">Paid out in real stocks.</span>
          </h2>
          <p className="mt-5 max-w-[62ch] text-[15px] leading-[1.7] text-muted">
            Every token on Coorwa is paired with one stock, NVDA, TSLA, SPY or another, picked by its
            creator. The price is two live markets divided: real reserves in a Cookie Chain pool over
            real xStock liquidity on Solana. Nothing is modelled.
          </p>

          <div className="num mt-6 inline-block rounded-full bg-[color-mix(in_srgb,var(--surface-raised)_78%,transparent)] px-5 py-3 text-[15px] text-primary">
            price(TOKEN in NVDA) = usd(TOKEN) &divide; usd(NVDAx)
          </div>

          <p className="mt-6 max-w-[62ch] text-[15px] leading-[1.7] text-muted">
            Holding the token pays you in that stock. Every day Coorwa bridges the fees, buys the
            xStock and sends it to <span className="text-primary">your own Solana wallet</span>, at
            the same address you hold the token with.
          </p>
        </GlassEffect>
      </Section>

      <Section>
        <RewardsCalculator />
        <p className="mt-6 max-w-[70ch] text-[14px] leading-[1.7] text-muted">
          Every fee Coorwa earns on a token goes to the wallets holding it, by how much they hold, and
          to whoever made it. It comes from MomoSwap&apos;s referral share of the curve fee, which
          costs a trader nothing, Coorwa&apos;s own 1% on a swap, and the dollar a creator pays for
          a pair. Once a day it is paid out in the token&apos;s stock, straight to holders&apos;
          wallets on Solana, with nothing to claim.{" "}
          <Link href="/rewards" className="text-primary underline underline-offset-4">
            See your rewards
          </Link>
          .
        </p>
      </Section>

      <SiteFooter />
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto w-full max-w-[1160px] px-5 py-7">{children}</section>;
}

function Tool({
  href,
  title,
  body,
  image,
}: {
  href: string;
  title: string;
  body: string;
  image: StaticImageData;
}) {
  return (
    <GlassEffect
      href={href}
      className="group flex min-h-[300px] flex-col rounded-[var(--radius-float)] p-7"
    >
      {/* Sits in the bottom corner and runs off the pane's edge, which clips it; the text goes over it. */}
      <Image
        src={image}
        alt=""
        aria-hidden
        sizes="(min-width: 768px) and (max-width: 1023px) 190px, 260px"
        className="pointer-events-none absolute -bottom-12 -right-10 z-0 h-[260px] w-[260px] select-none md:h-[190px] md:w-[190px] lg:h-[260px] lg:w-[260px] transition-transform duration-500 ease-out group-hover:-translate-y-1 group-hover:rotate-[-4deg] motion-reduce:transition-none motion-reduce:group-hover:transform-none"
      />
      <h3 className="title relative z-10 text-primary">{title}</h3>
      <p className="relative z-10 mt-3 max-w-[30ch] flex-1 text-[14px] leading-[1.7] text-muted">
        {body}
      </p>
      {/* The nav's well and chip, so "Open" reads as the same control as the links up top. */}
      <span className="nav-well relative z-10 mt-7 inline-flex self-start rounded-full p-1">
        <span className="nav-chip inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium text-primary">
          Open
          <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
        </span>
      </span>
    </GlassEffect>
  );
}

