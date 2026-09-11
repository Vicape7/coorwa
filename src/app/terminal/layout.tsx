import { SiteShell } from "@/components/site-shell";

/**
 * The terminal follows the reader's theme like every other page, so it is the same shell. The
 * dark tokens it used to force through a `.terminal` class now live under `data-theme="dark"`.
 */
export default function TerminalLayout({ children }: LayoutProps<"/terminal">) {
  return <SiteShell>{children}</SiteShell>;
}
