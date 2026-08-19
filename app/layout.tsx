import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

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

// metadataBase (absolute-URL prefix for og:/canonical fields) comes from the
// deployer's own origin. When NEXT_PUBLIC_CAPTURIA_ORIGIN is unset (the
// default, including packaged builds) it is omitted: no page here uses a
// relative URL-based metadata field, so nothing defaults to anyone's domain.
const deployOrigin = process.env.NEXT_PUBLIC_CAPTURIA_ORIGIN;

export const metadata: Metadata = {
  ...(deployOrigin ? { metadataBase: new URL(deployOrigin) } : {}),
  title: "Capturia · Broadcast-grade graphics on your camera, just by talking",
  description:
    "Speak your numbers, your name, your headline, and Capturia puts broadcast-grade graphics on your camera instantly. For founders, speakers, and creators on Zoom, Teams, and Meet. Free and open source.",
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
      <body>{children}</body>
    </html>
  );
}
