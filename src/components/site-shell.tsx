import { Nav } from "./nav";
import { SiteFooter } from "./site-footer";
import { AuroraField } from "./ui/liquid-glass";

/** The shell every page except the landing page shares, in either theme. */
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <AuroraField />
      <Nav />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
