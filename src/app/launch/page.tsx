import { SiteShell } from "@/components/site-shell";
import { LaunchView } from "@/components/launch-view";

export const metadata = {
  title: "Launch · Coorwa",
  description: "Launch a token on a COOK bonding curve and keep your share of every trade fee.",
};

/** The terminal's New and Soon tabs link here with `?pool=`, so that curve opens ready to trade. */
export default async function LaunchPage({ searchParams }: PageProps<"/launch">) {
  const { pool } = await searchParams;

  return (
    <SiteShell>
      <LaunchView initialPool={typeof pool === "string" ? pool : null} />
    </SiteShell>
  );
}
