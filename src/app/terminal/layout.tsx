import { Nav } from "@/components/nav";
import { AuroraField } from "@/components/ui/liquid-glass";

/**
 * The terminal runs on the dark surface. `.terminal` only redefines the shared design tokens, so
 * every component below renders correctly without knowing which surface it is on - including the
 * aurora field, which picks up the dark `--aurora-*` values from here.
 */
export default function TerminalLayout({ children }: LayoutProps<"/terminal">) {
  return (
    <div className="terminal relative flex min-h-screen flex-col">
      <AuroraField />
      <Nav />
      <main className="flex-1">{children}</main>
    </div>
  );
}
