import { Nav } from "./nav";

/** The light surface every page outside the terminal shares. */
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">{children}</main>
    </div>
  );
}
