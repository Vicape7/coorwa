import { SiteShell } from "@/components/site-shell";
import { RoadmapView } from "@/components/roadmap-view";

export const metadata = {
  title: "Roadmap · Coorwa",
  description:
    "The launch program Coorwa is writing for itself: what it does, what is built, and what is left.",
};

export default function RoadmapPage() {
  return (
    <SiteShell>
      <RoadmapView />
    </SiteShell>
  );
}
