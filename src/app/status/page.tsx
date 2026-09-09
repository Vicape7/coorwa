import { SiteShell } from "@/components/site-shell";
import { StatusView } from "@/components/status-view";

export const metadata = {
  title: "Status · Corwa",
  description: "The chain, services and programs Corwa depends on, and whether they are up.",
};

export default function StatusPage() {
  return (
    <SiteShell>
      <StatusView />
    </SiteShell>
  );
}
