import type { Metadata } from "next";
import Link from "next/link";
import LegalShell, { LegalSection } from "@/components/landing/LegalShell";

/* Plain-language terms for an indie product: honest defaults, no invented
   company entity. The refund promise (14 days, full, no questions, first
   subscription payment) is a product decision from issue #48; changing it
   means changing this page and the date. */

const LICENSE = "https://github.com/AndresCarreonDiaz/capturia/blob/main/LICENSE";

export const metadata: Metadata = {
  title: "Terms of Service · Capturia",
  description:
    "Plain-language terms for Capturia: MIT-licensed app, Pro billed via Stripe, cancel anytime, and a 14-day no-questions refund on a first subscription payment.",
};

export default function TermsPage() {
  return (
    <LegalShell eyebrow="Terms" title="Terms of Service" lastUpdated="July 21, 2026">
      <LegalSection title="Who you are dealing with">
        <p>
          Capturia is built and operated by Andres Carreon, an independent
          developer. There is no company boilerplate behind these terms; they
          are written to be read. Anything unclear:{" "}
          <a href="mailto:capturia@andresio.com" className="cue-link">
            capturia@andresio.com
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="The app and its license">
        <p>
          The Capturia app is open source under the{" "}
          <a href={LICENSE} target="_blank" rel="noopener noreferrer" className="cue-link">
            MIT license
          </a>
          , which is the license that governs your use of the software itself.
          These terms cover the hosted services around it: the website, the
          audience-vote pages, and the Capturia Pro subscription.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>
          Use Capturia for anything lawful. Do not use the hosted services to
          break the law, to harass or defraud people, or to probe, overload, or
          circumvent the service&rsquo;s limits and budgets. You are
          responsible for what you present on camera and for having the rights
          to any deck or content you load. Abuse can get a subscription
          suspended; if that ever happens you will hear why at the address you
          used to pay.
        </p>
      </LegalSection>

      <LegalSection title="Capturia Pro">
        <p>
          Pro is a monthly subscription billed by Stripe. It adds hosted AI and
          hosted audience voting on top of the free app. You can cancel
          anytime; cancellation takes effect at the end of the billing period
          already paid for, and you keep Pro until then. Prices can change,
          but never mid-cycle and never without notice before your next
          renewal.
        </p>
      </LegalSection>

      <LegalSection title="Refunds">
        <p>
          If Pro is not for you, your first subscription payment is refundable
          in full for 14 days, no questions asked. Write to{" "}
          <a href="mailto:capturia@andresio.com" className="cue-link">
            capturia@andresio.com
          </a>{" "}
          from your purchase email. Later renewals are not refunded; cancel
          before the renewal date instead.
        </p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>
          Capturia is provided as is, without warranty of any kind. It is
          software that renders live graphics over your camera; test it before
          the call that matters, and keep in mind that AI-generated output can
          be wrong.
        </p>
      </LegalSection>

      <LegalSection title="Liability">
        <p>
          To the extent the law allows, total liability for any claim related
          to Capturia is limited to the fees you paid for the service in the
          twelve months before the claim. For free-tier use that amount is
          zero.
        </p>
      </LegalSection>

      <LegalSection title="Governing law">
        <p>These terms are governed by the laws of Mexico.</p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          These terms can change; the date at the top tells you when they last
          did. Material changes to Pro will be announced before they apply to
          an existing subscription. Continued use after a change means
          acceptance. See also the{" "}
          <Link href="/privacy" className="cue-link">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>
    </LegalShell>
  );
}
