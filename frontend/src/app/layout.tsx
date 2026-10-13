import type { Metadata } from "next";
import { Bricolage_Grotesque, Sora, Syne } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";

/* Display — architectural, uncommon in AI defaults */
const syne = Syne({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

/* Thin geometric — eyebrows + supporting lines */
const sora = Sora({
  variable: "--font-thin",
  subsets: ["latin"],
  weight: ["200", "300", "400"],
});

/* Body / UI — distinctive grotesk, not Inter/Geist */
const bricolage = Bricolage_Grotesque({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "TradeArena — Paper trade. Get followed. Climb the board.",
  description:
    "TradeArena is a free paper-trading arena for crypto and forex. Traders compete on public leaderboards. Viewers follow every move.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${syne.variable} ${sora.variable} ${bricolage.variable} antialiased`}
    >
      <body className="min-h-screen flex flex-col bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
