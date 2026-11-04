import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { Footer, Nav } from "@/components/nav";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", weight: ["500", "600", "700", "800"] });
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "BLOKE — Back the work. Short the noise.", template: "%s · BLOKE" },
  description: "Go long or short a builder, priced by a live index of what they ship. Test money on Monad testnet.",
  applicationName: "BLOKE",
  openGraph: { type: "website", siteName: "BLOKE", title: "BLOKE — Back the work. Short the noise." },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: "#FBFAF9", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>
        <a href="#main" className="btn btn-ink sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50">
          Skip to content
        </a>
        <Providers>
          <Nav />
          <main id="main" className="mx-auto w-[min(1200px,calc(100%-40px))]">
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
