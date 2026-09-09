import Link from "next/link";
import { Nav } from "@/components/nav";
import { LiveStats, ChainBadge } from "@/components/live-stats";
import { RWA_ASSETS } from "@/lib/rwa";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />

      {/* Hero */}
      <section className="mx-auto w-full max-w-[1160px] px-5 pb-16 pt-16 sm:pt-24">
        <div className="rise">
          <ChainBadge />
        </div>

        <h1 className="display rise mt-6 max-w-[16ch] text-[clamp(2.75rem,7vw,4.75rem)] text-primary">
          Trade Cookie Chain in shares.
        </h1>

        <p className="rise mt-6 max-w-xl text-[17px] leading-[1.6] text-muted">
          Corwa prices every token on Cookie Chain against real equities, so you can see the only
          number that matters: <span className="text-primary">is this beating the stock?</span> When
          you want out, it routes you cross-chain into the actual xStock.
        </p>

        <div className="rise mt-8 flex flex-wrap gap-2.5">
          <Link href="/terminal" className="btn btn-primary">
            Open the terminal
          </Link>
          <Link href="/launch" className="btn btn-ghost">
            Launch a token
          </Link>
          <Link href="/pools" className="btn btn-quiet">
            Make a market
          </Link>
        </div>

        <div className="rise mt-14">
          <LiveStats />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-1.5">
          <span className="label mr-1 text-[12px]">Quote in</span>
          {RWA_ASSETS.slice(0, 9).map((a) => (
            <span key={a.ticker} className="pill pill-quiet">
              {a.ticker}
            </span>
          ))}
          <span className="pill pill-quiet">+{RWA_ASSETS.length - 9}</span>
        </div>
      </section>

      {/* Three in one */}
      <Section>
        <SectionHead
          eyebrow="The product"
          title="Three tools, one loop."
          lede="Every fee Corwa touches flows back to the people who created the thing being traded and the people trading it."
        />

        <div className="mt-10 grid gap-3 md:grid-cols-3">
          <Feature
            index="01"
            title="Terminal"
            body="Charts built from executed fills, not standing quotes. Both Cookie Chain routers quoted on every trade, better fill wins. Your wallet signs; Corwa never custodies."
            href="/terminal"
            cta="Trade"
          />
          <Feature
            index="02"
            title="Launchpad"
            body="Mint on a COOK bonding curve through MomoSwap. Creators keep their fee share, and Corwa's referral share is rebated rather than pocketed."
            href="/launch"
            cta="Launch"
          />
          <Feature
            index="03"
            title="LP maker"
            body="Open a pool on Cookiebox DAMM v2 or CLMM, manage the position, claim fees. The liquidity you provide is what makes the share-denominated pairs real."
            href="/pools"
            cta="Provide"
          />
        </div>
      </Section>

      {/* How the pairs work */}
      <Section>
        <div className="card p-8 sm:p-12">
          <div className="grid gap-14 lg:grid-cols-2">
            <div>
              <span className="label text-[12px]">The honest version</span>
              <h2 className="display mt-3 text-[clamp(1.75rem,3.4vw,2.5rem)] text-primary">
                There is no TOKEN/NVDA pool.
              </h2>
              <p className="mt-5 text-[15px] leading-[1.7] text-muted">
                And Corwa will not pretend there is. NVDAx, TSLAx and the rest live only on Solana,
                and Cookie Chain&apos;s bridge carries COOK alone. So a pair here is a{" "}
                <span className="text-primary">denomination</span>, built from two live market
                prices divided:
              </p>

              <div className="panel mt-6 p-6">
                <div className="num text-[15px] text-primary">
                  price(TOKEN in NVDA) = usd(TOKEN) &divide; usd(NVDAx)
                </div>
                <p className="mt-3 text-[14px] leading-[1.7] text-muted">
                  The numerator comes from real reserves in a Cookie Chain pool. The denominator
                  comes from real Solana liquidity. Neither is modelled, so the ratio is exact — a
                  change of units, not a synthetic instrument.
                </p>
              </div>

              <p className="mt-6 text-[15px] leading-[1.7] text-muted">
                When you want genuine exposure rather than a unit of account, Corwa routes you
                there: sell into COOK, bridge over Hyperlane, buy the xStock on Jupiter. The share
                lands in <span className="text-primary">your own Solana wallet</span>.
              </p>
            </div>

            <div>
              <span className="label text-[12px]">Why not just wrap it</span>
              <h2 className="display mt-3 text-[clamp(1.75rem,3.4vw,2.5rem)] text-primary">
                Because we read the mint.
              </h2>
              <p className="mt-5 text-[15px] leading-[1.7] text-muted">
                Wrapping an xStock onto Cookie Chain would be the easy demo. Its Token-2022 mint
                says otherwise.
              </p>

              <div className="panel mt-6 divide-y divide-[color:var(--divider)]">
                <Risk name="permanentDelegate">
                  The issuer can claw tokens out of any account — a bridge escrow included, leaving
                  the wrapped supply unbacked.
                </Risk>
                <Risk name="pausableConfig">
                  All transfers can be halted globally, freezing anything in flight.
                </Risk>
                <Risk name="scaledUiAmountConfig">
                  The token rebases. A wrapper that locks raw units and mints a fixed supply drifts
                  away from its own backing.
                </Risk>
                <Risk name="transferHook">
                  Inactive today, but the authority exists. Switching it on would break any pool
                  holding it.
                </Risk>
              </div>

              <p className="mt-6 text-[15px] leading-[1.7] text-muted">
                Routing into your wallet instead of escrowing sidesteps every one of these.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* Cashback */}
      <Section>
        <SectionHead
          eyebrow="Cashback"
          title="Fees you generate come back."
          lede="Not a points programme — real fee streams that already exist on Cookie Chain, redirected instead of pocketed."
        />

        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          <Money
            pct="50"
            who="Traders"
            body="Rebated on the volume you put through Corwa, claimable in COOK."
          />
          <Money
            pct="30"
            who="Creators"
            body="If you launched the token being traded, you earn on every fill — on top of MomoSwap's own creator fee."
          />
          <Money
            pct="20"
            who="Liquidity"
            body="Returned to the pool, so the pairs get deeper rather than thinner."
          />
        </div>

        <div className="card mt-3 p-8">
          <p className="max-w-3xl text-[14px] leading-[1.7] text-muted">
            <span className="text-primary">Where the money is from.</span> MomoSwap pays a referrer
            20% of its 1% curve fee, out of the same fee either way — with no referrer named, the
            programme keeps that share itself. So Corwa naming itself costs a trader nothing and
            funds the rebate honestly. Swaps are a different story: neither Cookie Chain router
            exposes a platform fee yet, so those fills earn Corwa nothing and are recorded at zero
            rather than credited with a rebate no fee is backing.
          </p>
          <Link href="/rewards" className="btn btn-ink mt-7">
            See your cashback
          </Link>
        </div>
      </Section>

      <footer className="mt-auto">
        <div className="mx-auto w-full max-w-[1160px] px-5 pb-12">
          <div className="card p-8">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-[14px] text-muted">
              <span className="title text-primary">corwa</span>
              <span>Built on Cookie Chain.</span>
              <div className="ml-auto flex flex-wrap gap-6">
                <FooterLink href="https://www.cookiechain.wtf">Cookie Chain</FooterLink>
                <FooterLink href="https://docs.cookiechain.wtf">Docs</FooterLink>
                <FooterLink href="https://cookiescan.io">Explorer</FooterLink>
                <Link
                  href="/status"
                  className="transition-colors hover:text-[color:var(--text-primary)]"
                >
                  Status
                </Link>
              </div>
            </div>
            <p className="mt-6 max-w-3xl text-[12px] leading-[1.7] text-subtle">
              Corwa is a non-custodial interface. It never holds your assets and never signs for
              you. Tokens on Cookie Chain are volatile and can lose all value; tokenised equities
              carry issuer and transfer-restriction risk of their own. Nothing here is investment
              advice.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section>
      <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">{children}</div>
    </section>
  );
}

function SectionHead({ eyebrow, title, lede }: { eyebrow: string; title: string; lede: string }) {
  return (
    <div className="max-w-2xl">
      <span className="label text-[12px]">{eyebrow}</span>
      <h2 className="display mt-3 text-[clamp(1.75rem,3.4vw,2.5rem)] text-primary">{title}</h2>
      <p className="mt-4 text-[15px] leading-[1.7] text-muted">{lede}</p>
    </div>
  );
}

function Feature({
  index,
  title,
  body,
  href,
  cta,
}: {
  index: string;
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="card group flex flex-col p-7 transition-shadow hover:shadow-[var(--shadow-float)]"
    >
      <span className="num text-[12px] text-subtle">{index}</span>
      <h3 className="title mt-3 text-primary">{title}</h3>
      <p className="mt-3 flex-1 text-[14px] leading-[1.7] text-muted">{body}</p>
      <span className="mt-7 inline-flex items-center gap-1.5 text-[13px] font-medium text-primary">
        {cta}
        <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
      </span>
    </Link>
  );
}

function Risk({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 p-5 sm:flex-row sm:gap-5">
      <span className="num shrink-0 text-[13px] text-primary sm:w-[186px]">{name}</span>
      <p className="text-[14px] leading-[1.7] text-muted">{children}</p>
    </div>
  );
}

function Money({ pct, who, body }: { pct: string; who: string; body: string }) {
  return (
    <div className="card p-7">
      <div className="num display text-[56px] leading-none text-primary">
        {pct}
        <span className="text-[26px] text-subtle">%</span>
      </div>
      <div className="mt-4 text-[15px] font-medium text-primary">{who}</div>
      <p className="mt-2 text-[14px] leading-[1.7] text-muted">{body}</p>
    </div>
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
