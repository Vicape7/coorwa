import { SiteShell } from "@/components/site-shell";
import { RewardsView } from "@/components/rewards-view";

export const metadata = {
  title: "Rewards · Coorwa",
  description: "Cashback on the fees you generate, as a trader and as a creator.",
};

export default function RewardsPage() {
  return (
    <SiteShell>
      <RewardsView />
    </SiteShell>
  );
}
