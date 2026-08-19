import type { AnchorHTMLAttributes, ReactNode } from "react";

// Plain anchor for the landing's download-intent CTAs. The CTAs link the
// latest release (a Developer ID signed, notarized DMG). `location` names the
// CTA (hero, nav, footer, ...); it lands on the element as a data attribute so
// call sites stay descriptive and tests can target a specific CTA.
export default function DownloadLink({
  location,
  children,
  ...anchor
}: AnchorHTMLAttributes<HTMLAnchorElement> & { location: string; children: ReactNode }) {
  return (
    <a {...anchor} data-location={location}>
      {children}
    </a>
  );
}
