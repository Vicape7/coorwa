import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { WalletProviders } from "@/components/wallet-providers";
import { GlassFilter } from "@/components/ui/liquid-glass";
import { THEME_SCRIPT } from "@/lib/theme";

/**
 * One typeface for the whole product - headings, stat numbers and addresses alike. Inter's tabular
 * figures cover every case a monospace face would otherwise be dragged in for.
 */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Coorwa - trade Cookie Chain in RWAs",
  description:
    "Terminal, launchpad and LP maker for Cookie Chain. Price every token in NVDA, TSLA or SPY, route cross-chain into real xStocks, and earn fee cashback on every trade.",
  openGraph: {
    title: "Coorwa - trade Cookie Chain in RWAs",
    description:
      "Price every Cookie Chain token in real-world shares, settle cross-chain into real xStocks, and earn cashback from the fees you generate.",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // The head script may set data-theme on <html> before React hydrates, so that one element is
  // allowed to differ from what the server rendered.
  return (
    <html lang="en" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Document-scoped, so it is declared once here rather than per glass surface. */}
        <GlassFilter />
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
