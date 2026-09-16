import { SiteShell } from "@/components/site-shell";
import { RewardsView } from "@/components/rewards-view";

export const metadata = {
  title: "Rewards · Coorwa",
  description: "Hold a token, get paid in its stock: fees go to its holders and its creator once a day.",
};

export default function RewardsPage() {
  return (
    <SiteShell>
      <RewardsView />
    </SiteShell>
  );
}
