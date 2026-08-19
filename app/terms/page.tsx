import type { Metadata } from "next";
import Link from "next/link";
import LegalShell, { LegalSection } from "@/components/landing/LegalShell";

/* Plain-language terms for a free, open-source app: the MIT license does the
   heavy lifting, this page just says so readably. There is no paid tier, no
   subscription, and no hosted service behind the software. */

const LICENSE = "https://github.com/AndresCarreonDiaz/capturia/blob/main/LICENSE";
const ISSUES = "https://github.com/AndresCarreonDiaz/capturia/issues";

export const metadata: Metadata = {
  title: "Terms of Service · Capturia",
  description:
    "Plain-language terms for Capturia: a free, MIT-licensed open-source app you run yourself, provided as is with no warranty.",
};

export default function TermsPage() {
  return (
    <LegalShell eyebrow="Terms" title="Terms of Service" lastUpdated="August 18, 2026">
      <LegalSection title="The app and its license">
        <p>
          Capturia is free and open source under the{" "}
          <a href={LICENSE} target="_blank" rel="noopener noreferrer" className="cue-link">
            MIT license
          </a>
          , which governs your use of the software: use it, modify it, and
          redistribute it under the license&rsquo;s terms. There is no paid
          tier and no subscription. It is built by Andres Carreon, an
          independent developer; these terms are written to be read, and
          anything unclear can be raised on{" "}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer" className="cue-link">
            the GitHub issues page
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="Self-hosted vote pages">
        <p>
          The audience-vote pages run on whatever server you (or whoever gave
          you the link) deploy the software to. Whoever runs a deployment is
          responsible for it and for complying with the laws that apply to it;
          no Capturia-operated service is behind it.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>
          Use Capturia for anything lawful. Do not use it, or a deployment of
          it, to break the law or to harass or defraud people. You are
          responsible for what you present on camera and for having the rights
          to any deck or content you load.
        </p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>
          Capturia is provided as is, without warranty of any kind, as the MIT
          license spells out. It is software that renders live graphics over
          your camera; test it before the call that matters, and keep in mind
          that AI-generated output can be wrong.
        </p>
      </LegalSection>

      <LegalSection title="Liability">
        <p>
          The software is free, and per the MIT license its authors are not
          liable for any claim or damages arising from it, to the extent the
          law allows.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          These terms can change; the date at the top tells you when they last
          did. Continued use after a change means acceptance. See also the{" "}
          <Link href="/privacy" className="cue-link">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>
    </LegalShell>
  );
}
