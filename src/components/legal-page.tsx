import Link from "next/link";

export interface LegalSection {
  title: string;
  body: React.ReactNode;
}

/** Terms, privacy and risks share one plain, readable layout. */
export function LegalPage({
  label,
  title,
  updated,
  intro,
  sections,
}: {
  label: string;
  title: string;
  updated: string;
  intro: React.ReactNode;
  sections: LegalSection[];
}) {
  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="label text-[12px]">{label}</span>
        <h1 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)] text-primary">{title}</h1>
        <p className="mt-3 text-[13px] text-subtle">Last updated {updated}</p>
        <div className="mt-4 text-[15px] leading-[1.7] text-muted">{intro}</div>
      </div>

      <div className="card mt-10 p-7 sm:p-10">
        <div className="max-w-[72ch] space-y-9">
          {sections.map((s, i) => (
            <section key={s.title}>
              <h2 className="text-[17px] text-primary">
                <span className="num mr-2 text-subtle">{i + 1}.</span>
                {s.title}
              </h2>
              <div className="mt-3 space-y-3 text-[14px] leading-[1.75] text-muted">{s.body}</div>
            </section>
          ))}
        </div>
      </div>

      <p className="mt-6 text-[13px] text-subtle">
        See also{" "}
        <Link href="/terms" className="underline underline-offset-4">
          Terms
        </Link>
        ,{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          Privacy
        </Link>{" "}
        and{" "}
        <Link href="/risks" className="underline underline-offset-4">
          Risks
        </Link>
        .
      </p>
    </div>
  );
}
