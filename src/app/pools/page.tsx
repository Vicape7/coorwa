import { SiteShell } from "@/components/site-shell";
import { PoolsView } from "@/components/pools-view";

export const metadata = {
  title: "Pools · Corwa",
  description: "Provide liquidity on Cookie Chain and see your position sized in shares.",
};

export default function PoolsPage() {
  return (
    <SiteShell>
      <PoolsView />
    </SiteShell>
  );
}
