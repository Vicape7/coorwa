import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { WalletProviders } from "@/components/wallet-providers";

/**
 * One typeface for the whole product — headings, stat numbers and addresses alike. Inter's tabular
 * figures cover every case a monospace face would otherwise be dragged in for.
 */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Corwa — trade Cookie Chain in shares",
  description:
    "Terminal, launchpad and LP maker for Cookie Chain. Price every token in NVDA, TSLA or SPY, route cross-chain into real xStocks, and earn fee cashback on every trade.",
  openGraph: {
    title: "Corwa — trade Cookie Chain in shares",
    description:
      "Price every Cookie Chain token in real-world shares, settle cross-chain into real xStocks, and earn cashback from the fees you generate.",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
