import type { SVGProps } from "react";

/**
 * Brand marks for Capturia.
 *
 * Concept: a broadcast viewfinder bracket framing a tally lamp.
 *   - The square bracket "[" reads as a C (the letter) and a viewfinder
 *     corner (the broadcast frame guide) at once.
 *   - The tally dot inside reads as "this is being captured, live".
 *   - Built from rectangles so the mark stays crisp at 16px (favicon)
 *     all the way up to display sizes.
 *
 * Color contract: `currentColor` drives the bracket + wordmark so the
 * mark inherits from the surrounding text color. The tally lamp + halo
 * are pinned to `var(--tally)` so the live indicator is always tally red.
 */

type MarkProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "xmlns"> & {
  animated?: boolean;
};

export function CapturiaMark({ animated = true, ...rest }: MarkProps) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Capturia"
      {...rest}
    >
      {/* Viewfinder bracket "[" — vertical bar with two short stubs */}
      <g fill="currentColor">
        <rect x="5"   y="9"    width="2.5" height="22" />
        <rect x="5"   y="9"    width="11"  height="2.5" />
        <rect x="5"   y="28.5" width="11"  height="2.5" />
      </g>

      {/* Tally halo — pulses softly when animated */}
      <circle
        cx="27"
        cy="20"
        r="7"
        fill="none"
        stroke="var(--tally, #ff2d4f)"
        strokeWidth="0.85"
        opacity="0.45"
        className={animated ? "tally-halo-pulse" : ""}
      />

      {/* Tally lamp */}
      <circle cx="27" cy="20" r="3.5" fill="var(--tally, #ff2d4f)" />
    </svg>
  );
}

type LogoProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "xmlns"> & {
  animated?: boolean;
};

export function CapturiaLogo({ animated = true, ...rest }: LogoProps) {
  return (
    <svg
      viewBox="0 0 240 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Capturia"
      {...rest}
    >
      {/* Mark: viewfinder bracket "[" with tally lamp inside */}
      <g fill="currentColor">
        <rect x="2"   y="9"    width="2.5" height="22" />
        <rect x="2"   y="9"    width="11"  height="2.5" />
        <rect x="2"   y="28.5" width="11"  height="2.5" />
      </g>
      <circle
        cx="24"
        cy="20"
        r="7"
        fill="none"
        stroke="var(--tally, #ff2d4f)"
        strokeWidth="0.85"
        opacity="0.45"
        className={animated ? "tally-halo-pulse" : ""}
      />
      <circle cx="24" cy="20" r="3.5" fill="var(--tally, #ff2d4f)" />

      {/* Wordmark in Instrument Serif italic, dropped baseline */}
      <text
        x="42"
        y="20"
        fill="currentColor"
        fontFamily="var(--font-instrument-serif), Georgia, 'Times New Roman', serif"
        fontStyle="italic"
        fontSize="30"
        letterSpacing="-0.6"
        dominantBaseline="central"
      >
        Capturia
      </text>
    </svg>
  );
}
