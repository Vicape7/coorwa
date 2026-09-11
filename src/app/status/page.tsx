import { SiteShell } from "@/components/site-shell";
import { StatusView } from "@/components/status-view";

export const metadata = {
  title: "Status · Coorwa",
  description: "The chain, services and programs Coorwa depends on, and whether they are up.",
};

export default function StatusPage() {
  return (
    <SiteShell>
      <StatusView />
    </SiteShell>
  );
}
