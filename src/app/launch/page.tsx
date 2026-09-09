import { SiteShell } from "@/components/site-shell";
import { LaunchView } from "@/components/launch-view";

export const metadata = {
  title: "Launch · Corwa",
  description: "Launch a token on a COOK bonding curve and keep your share of every trade fee.",
};

export default function LaunchPage() {
  return (
    <SiteShell>
      <LaunchView />
    </SiteShell>
  );
}
