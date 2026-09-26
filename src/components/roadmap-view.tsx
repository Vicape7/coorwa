import Link from "next/link";
import { LAUNCH_PROGRAM_ADDRESS } from "@/lib/config";

const REPO = "https://github.com/Vicape7/coorwa";

/** The day the page below was last edited by hand. */
const UPDATED = "26 September 2026";

interface Milestone {
  sha: string;
  date: string;
  title: string;
  body: React.ReactNode;
  note: string;
}

/**
 * What is already in `main`. One entry per commit, oldest first, so the list reads the way the work
 * happened. Add to it when a commit lands; the shas are what make this page checkable rather than a
 * claim.
 */
const BUILT: Milestone[] = [
  {
    sha: "bb6a47b",
    date: "22 September 2026",
    title: "The mint and the curve",
    body: (
      <>
        The program creates the token itself: Token-2022, six decimals, the reward tax written into
        the mint at birth with nobody left who could change it, a fixed supply minted once and the
        mint authority dropped. It then sells that supply on a constant-product curve against COOK,
        holding the tokens in a vault it owns, so a buy moves real tokens and the tax earns from the
        very first trade.
      </>
    ),
    note: "2,402 lines added",
  },
  {
    sha: "d1ee4aa",
    date: "22 September 2026",
    title: "Graduation into a locked pool, rehearsed",
    body: (
      <>
        When a curve reaches its target the program opens a Cookiebox pool on its own, seeds it with
        what the curve raised, keeps the position under an address only the program controls and
        locks it there permanently. Tokens the curve did not sell are burned. This commit also
        brings the client the app will use, and an integration test that runs a whole launch, from
        an empty chain to a locked pool, against the real pool program rather than a stand-in.
      </>
    ),
    note: "151 unit tests, 21 integration tests",
  },
  {
    sha: "aef153c",
    date: "22 September 2026",
    title: "Coorwa hosts the metadata",
    body: (
      <>
        A token&apos;s name, symbol and picture have to live somewhere a wallet can read them, and
        the link to them is written into the mint at launch, where it can never be edited again.
        Coorwa serves that itself now, on its own domain: one document per mint, stored when the
        launch is built, signed for by the creator so nobody can write in their name, and frozen the
        moment the token exists on chain.
      </>
    ),
    note: "734 lines added",
  },
  {
    sha: "8b7e341",
    date: "26 September 2026",
    title: "Launching moved onto it",
    body: (
      <>
        The launch page builds its own transaction now: the mint is made in the browser, the
        creator signs for their metadata, and the wallet signs what the page assembled rather than
        something a server handed back. A creator picks the tax there, and a buy at launch rides in
        the same transaction. Launching on the old launchpad is closed; the tokens created there
        keep trading and their creators keep what those curves earned them.
      </>
    ),
    note: "the program went live on Cookie Chain the same day",
  },
  {
    sha: "e2bbdf0",
    date: "26 September 2026",
    title: "Trading and charts, from the program's own events",
    body: (
      <>
        A launch appears in the terminal as soon as it lands, with a pair page priced from the curve
        account, a chart and a fill list built from the trades the program itself reports, and a
        panel that buys and sells against the curve. The first real token was launched, bought and
        sold through all of it.
      </>
    ),
    note: "3 fills, read from the chain",
  },
];

/** Still to do, in the order it will be done. */
const LEFT: { title: string; body: string }[] = [
  {
    title: "The tax collected and paid out",
    body: "A scheduled run sweeps what the mints withheld and hands it to the payout that already buys the stock and sends it to holders every day.",
  },
  {
    title: "Graduation, watched and driven",
    body: "The program opens and locks the pool, but something has to call it the moment a curve fills. That job runs on a schedule, and the first graduation will be watched by hand.",
  },
  {
    title: "The curve's fees claimed",
    body: "What the 1% has earned sits on each curve until Coorwa claims it. One more scheduled run, into the same wallet the payout spends from.",
  },
  {
    title: "The upgrade authority given up",
    body: "Once the program has run quietly for a while, the key that can change it is thrown away and this page says so on the day it happens.",
  },
];

/**
 * A public page for one piece of work: the launch program Coorwa wrote for itself.
 *
 * The commits carry the page. Everything else on it is there to say what they add up to, which is
 * a token that pays its holders wherever it trades.
 */
export function RoadmapView() {
  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">Roadmap</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">
          A launch program of Coorwa&apos;s own.
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="pill pill-active">Live on Cookie Chain</span>
          <span className="pill pill-quiet">Upgrade authority still held</span>
          <span className="text-[13px] text-subtle">Updated {UPDATED}</span>
        </div>
        <p className="mt-5 text-[15px] leading-[1.7] text-muted">
          Coorwa has its own launch program, and it is running. It mints the token, sells it on its
          own curve, and at the target opens a pool and locks the liquidity in it forever. The token
          carries its reward tax on the mint, so it pays its holders wherever it trades, from the
          first trade onwards. Every launch on{" "}
          <Link href="/launch" className="underline underline-offset-4">
            Launch
          </Link>{" "}
          goes through it, and the first token has already been launched, bought and sold on it.
        </p>
      </div>

      <div className="card mt-10 p-5 sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="title text-primary">The commits</h2>
          <a
            href={`${REPO}/tree/main/programs/corwa-launch`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[13px] text-muted underline underline-offset-4 transition-colors hover:text-[color:var(--text-primary)]"
          >
            Read the program
          </a>
        </div>
        <p className="mt-1.5 text-[13px] text-muted">
          Every line of it is public. Each entry opens the commit it came from.
        </p>

        <ol className="mt-7 space-y-8">
          {BUILT.map((m) => (
            <li key={m.sha} className="relative grid gap-x-8 gap-y-2 pl-6 lg:grid-cols-[300px_1fr]">
              <span
                aria-hidden
                className="absolute left-0 top-[9px] h-2 w-2 rounded-full bg-[var(--color-up)]"
              />
              <div>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-[16px] text-primary">{m.title}</h3>
                  <a
                    href={`${REPO}/commit/${m.sha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="pill pill-quiet num text-[11px] transition-colors hover:text-[color:var(--text-primary)]"
                  >
                    {m.sha}
                  </a>
                </div>
                <p className="mt-1.5 text-[12px] text-subtle">
                  {m.date} <span className="mx-1.5">·</span> {m.note}
                </p>
              </div>
              <p className="max-w-[72ch] text-[14px] leading-[1.75] text-muted">{m.body}</p>
            </li>
          ))}
        </ol>

        <p className="mt-8 border-t border-hair pt-5 text-[13px] text-muted">
          The program runs at{" "}
          <span className="num break-all text-subtle">{LAUNCH_PROGRAM_ADDRESS}</span>, and the pool
          it graduates into is Cookiebox&apos;s, the same one every migrated token on this chain
          uses.
        </p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card p-5 sm:p-8">
          <h2 className="title text-primary">What a launch does</h2>
          <p className="mt-1.5 text-[13px] text-muted">The rules the program holds to.</p>
          <dl className="mt-5 divide-y divide-[color:var(--divider)]">
            <Rule label="The mint">
              Token-2022, six decimals, a supply minted once with no authority left to mint more, no
              freeze authority, and no way for anyone to change the tax afterwards.
            </Rule>
            <Rule label="The tax">
              1%, 2% or 3%, chosen by the creator at launch. All of it goes to the token&apos;s
              holders, paid in the stock the token is paired with, through the payout that already
              runs every day.
            </Rule>
            <Rule label="The curve">
              A constant-product curve priced in COOK. Buys move real tokens out of the
              program&apos;s vault, which is what makes the tax collect from the first trade.
            </Rule>
            <Rule label="Graduation">
              At 1,000,000 COOK raised the program opens a Cookiebox pool itself, locks the
              liquidity in it permanently and burns whatever the curve did not sell.
            </Rule>
            <Rule label="What it costs">
              The curve charges 1%, the same rate as a launch costs today, and Coorwa&apos;s own 1%
              terminal fee is dropped for these tokens so no trade is charged twice.
            </Rule>
            <Rule label="After graduation">
              The locked position earns 0.8% of every trade in the pool, split 60% to Coorwa and 40%
              to the creator, for as long as the pool exists.
            </Rule>
          </dl>
        </div>

        <div className="card p-5 sm:p-8">
          <h2 className="title text-primary">What is next</h2>
          <p className="mt-1.5 text-[13px] text-muted">In the order it lands.</p>
          <ol className="mt-6 space-y-5">
            {LEFT.map((step, i) => (
              <li key={step.title} className="grid grid-cols-[28px_1fr] gap-x-3">
                <span className="num pt-0.5 text-[12px] text-subtle">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-[15px] text-primary">{step.title}</h3>
                  <p className="mt-1 text-[13px] leading-[1.7] text-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function Rule({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_1fr] gap-4 py-3.5 first:pt-0 last:pb-0">
      <dt className="text-[13px] text-subtle">{label}</dt>
      <dd className="text-[13px] leading-[1.7] text-muted">{children}</dd>
    </div>
  );
}
