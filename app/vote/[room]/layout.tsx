import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Capturia Live Vote",
  description: "Vote on the live poll happening on screen.",
  robots: { index: false }, // rooms are ephemeral; never index vote links
};

export default function VoteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
