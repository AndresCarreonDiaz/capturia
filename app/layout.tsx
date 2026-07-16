import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Cookieless pageview tracking for the hosted web surfaces (landing, /studio
// demo, /vote phone pages). The Electron static export must NOT mount it: the
// desktop app is measured by the anonymous beacon instead (docs/telemetry.md)
// and an analytics script is dead weight on file://. Same build-time switch
// next.config.ts keys the export on; next.config also aliases the package to
// a no-op stub in that build so no analytics code lands in the bundle at all.
const isElectronBuild = process.env.CAPTURIA_ELECTRON_BUILD === "1";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.capturia.dev"),
  title: "Capturia · Broadcast-grade graphics on your camera, just by talking",
  description:
    "Speak your numbers, your name, your headline, and Capturia puts broadcast-grade graphics on your camera instantly. For founders, speakers, and creators on Zoom, Teams, and Meet. Free to start.",
  openGraph: {
    title: "Capturia · Broadcast-grade graphics on your camera, just by talking",
    description:
      "Speak your numbers, your name, your headline, and Capturia puts them on your camera instantly. Works in Zoom, Teams, and Meet.",
    type: "website",
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
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased`}
    >
      <body>
        {children}
        {!isElectronBuild && <Analytics />}
      </body>
    </html>
  );
}
