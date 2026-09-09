import { Nav } from "@/components/nav";

/**
 * The terminal runs on the dark surface. `.terminal` only redefines the shared design tokens, so
 * every component below renders correctly without knowing which surface it is on.
 */
export default function TerminalLayout({ children }: LayoutProps<"/terminal">) {
  return (
    <div className="terminal flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">{children}</main>
    </div>
  );
}
