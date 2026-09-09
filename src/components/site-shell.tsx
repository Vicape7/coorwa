import { Nav } from "./nav";
import { AuroraField } from "./ui/liquid-glass";

/** The light surface every page outside the terminal shares. */
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <AuroraField />
      <Nav />
      <main className="flex-1">{children}</main>
    </div>
  );
}
