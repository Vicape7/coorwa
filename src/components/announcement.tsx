import Link from "next/link";

/**
 * What Coorwa is in the middle of, said in the two places it changes what someone can do.
 *
 * The launch program is on Cookie Chain and works, but the jobs that pay a token's holders and open
 * its pool do not run by themselves yet, so launching stays shut until they do. Rather than a
 * disabled button with no explanation, both pages say what is happening and link to the page that
 * carries the commits.
 *
 * `compact` is the terminal's version: one line above a list that still works, rather than a card
 * standing in for something that does not.
 */
export function Announcement({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="card flex items-baseline gap-3 px-5 py-3.5">
        <span className="pill pill-active shrink-0">New</span>
        <p className="text-[13px] leading-relaxed text-muted">
          Coorwa runs its own launch program now, and the first token trades here. Launching opens
          to everyone once the rest of the pipe runs on its own.{" "}
          <Link
            href="/roadmap"
            className="whitespace-nowrap text-primary underline underline-offset-4"
          >
            See where it stands
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="card p-5 sm:p-7">
      <span className="pill pill-active">Coming soon</span>
      <h2 className="display mt-4 text-[clamp(1.5rem,3vw,2rem)] text-primary">
        Launching opens shortly.
      </h2>
      <div className="mt-4 max-w-[60ch] space-y-3 text-[14px] leading-[1.75] text-muted">
        <p>
          Coorwa&apos;s own launch program is live on Cookie Chain. A token minted by it carries its
          reward tax on the mint, sells on a curve here, and opens a locked pool when it graduates.
          The first one has already been launched, bought and sold on it.
        </p>
        <p>
          Two things still run by hand, and both of them are somebody&apos;s money: the sweep that
          collects a token&apos;s tax and pays it to holders, and the job that opens the pool the
          moment a curve fills. Launching opens to everyone when those run on their own, and not
          before.
        </p>
      </div>
      <Link href="/roadmap" className="btn btn-primary mt-6 inline-flex">
        See where it stands
      </Link>
    </div>
  );
}
