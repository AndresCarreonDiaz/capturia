"use client";

import { track } from "@vercel/analytics";
import type { AnchorHTMLAttributes, ReactNode } from "react";

// The one custom Vercel Analytics event on the web surfaces: a click on a
// download-intent CTA on the landing. Pageviews come for free from the
// <Analytics /> mount in the root layout; this adds the page -> download edge
// of the funnel (visits -> download clicks -> beacon-counted installs).
//
// The landing's Download CTAs link the latest release (a Developer ID
// signed, notarized DMG). Every download-intent CTA routes through this
// component (or calls trackDownloadClick from its own handler) so the funnel
// keeps a single, comparable event name.
export const DOWNLOAD_EVENT = "download_click";

export function trackDownloadClick(location: string) {
  track(DOWNLOAD_EVENT, { location });
}

// Anchor wrapper for server-component pages: the landing is a server
// component (bundle contract), so the click handler needs this tiny client
// boundary. Renders a plain <a> with whatever props the call site styles it
// with; `location` names the CTA so the funnel can tell hero from footer.
export default function DownloadLink({
  location,
  children,
  ...anchor
}: AnchorHTMLAttributes<HTMLAnchorElement> & { location: string; children: ReactNode }) {
  return (
    <a {...anchor} onClick={() => trackDownloadClick(location)}>
      {children}
    </a>
  );
}
