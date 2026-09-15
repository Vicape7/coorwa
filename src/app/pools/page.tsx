import { SiteShell } from "@/components/site-shell";
import { PoolsViewClient } from "@/components/pools-view-client";

export const metadata = {
  title: "Pools · Coorwa",
  description: "Provide liquidity on Cookie Chain and see your position sized in shares.",
};

export default function PoolsPage() {
  return (
    <SiteShell>
      <PoolsViewClient />
    </SiteShell>
  );
}
