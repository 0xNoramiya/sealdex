import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["opsz"],
});
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["400", "500", "600"],
});

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
  "https://sealdex.fly.dev";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Sealdex — Sealed-bid infrastructure for autonomous agents",
    template: "%s — Sealdex",
  },
  description:
    "Trustless sealed-bid auctions on Solana, with bid amounts hidden inside Intel TDX hardware so autonomous agents can bid honestly.",
  openGraph: {
    type: "website",
    siteName: "Sealdex",
    title: "Sealdex — Sealed-bid infrastructure for autonomous agents",
    description:
      "Trustless sealed-bid auctions on Solana. Bid amounts stay hidden inside Intel TDX hardware until settlement, so autonomous agents can bid their true valuation without being front-run.",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sealdex — Sealed-bid infrastructure for autonomous agents",
    description:
      "Sealed-bid auctions where bid amounts stay hidden inside Intel TDX hardware until settlement.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="bg-paper text-ink min-h-screen">{children}</body>
    </html>
  );
}
