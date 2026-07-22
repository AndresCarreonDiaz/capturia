import type { Metadata } from "next";
import LegalShell, { LegalSection } from "@/components/landing/LegalShell";

/* Privacy policy for the product and the hosted web surfaces. Every claim in
   here is grounded in shipped code and kept in sync with it: the beacon
   contract lives in electron/telemetry.js + docs/telemetry.md, the hosted
   proxy's storage in lib/hosted/* + docs/hosted-tier.md. If a data flow
   changes, this page changes in the same PR. */

const TELEMETRY_DOC =
  "https://github.com/AndresCarreonDiaz/capturia/blob/main/docs/telemetry.md";
const GITHUB = "https://github.com/AndresCarreonDiaz/capturia";

export const metadata: Metadata = {
  title: "Privacy Policy · Capturia",
  description:
    "What Capturia collects and what it never sees: on-device speech in the desktop app, an anonymous four-field beacon you can switch off, no accounts, and no user database.",
};

export default function PrivacyPage() {
  return (
    <LegalShell eyebrow="Privacy" title="Privacy Policy" lastUpdated="July 22, 2026">
      <LegalSection title="The short version">
        <p>
          Capturia has no accounts, no sign-up, and no user database. In the
          desktop app, your voice is transcribed on your Mac and your call
          audio never leaves it. The app sends one anonymous, four-field usage
          ping that you can switch off. The product is open source under MIT, so every claim on this
          page is verifiable in{" "}
          <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="cue-link">
            the source
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="Your voice and your calls">
        <p>
          In the desktop app, speech recognition runs on your Mac:
          Apple&rsquo;s speech engine on macOS 26, a local Whisper model on
          earlier versions. No bot joins your meeting, nothing is recorded, and
          no call audio or video is sent to Capturia. Only the transcribed
          command, and any deck you choose to load, go to the AI provider that
          powers your setup (your own provider on the free tier,
          Capturia&rsquo;s hosted proxy on Pro, below).
        </p>
        <p>
          The browser demo is the exception: dictation there is handled by your
          browser&rsquo;s built-in speech service, not on your machine. In
          Chrome that service sends your microphone audio to Google for
          recognition, governed by Google&rsquo;s privacy policy; Capturia
          receives only the resulting transcript.
        </p>
      </LegalSection>

      <LegalSection title="The anonymous usage beacon">
        <p>
          When telemetry is on, the desktop app sends exactly four fields: a
          random install id (a UUID connected to nothing, no account, no email,
          no hardware id), the event name (such as &ldquo;launch&rdquo;), the
          app version, and the macOS version. Never sent, by construction:
          audio, transcripts, prompts, overlay or deck content, API keys, file
          names, or any free-form text. The server rejects payloads with extra
          fields, and it stores aggregate counts only: individual install ids
          are not recoverable from storage, and raw IP addresses are never
          stored. Those aggregate counts are publicly visible at{" "}
          <a href="/metrics" className="cue-link">
            /metrics
          </a>
          , so you can see everything the beacon adds up to, exactly as we do.
        </p>
        <p>
          Nothing is sent before you have seen the first-run disclosure and its
          toggle. You can turn the beacon off there, in Settings under Privacy,
          or by hand in the app&rsquo;s settings file.{" "}
          <a href={TELEMETRY_DOC} target="_blank" rel="noopener noreferrer" className="cue-link">
            docs/telemetry.md
          </a>{" "}
          shows the exact bytes on the wire and the exact server-side keys.
        </p>
      </LegalSection>

      <LegalSection title="Bring-your-own-key (free tier)">
        <p>
          On the free tier you supply your own AI key. It is encrypted on your
          Mac with a key held in the macOS Keychain, travels only to your model
          provider, and is never sent to or stored on a Capturia server. What
          that provider does with your requests is governed by its own terms
          and privacy policy.
        </p>
      </LegalSection>

      <LegalSection title="The hosted proxy (Capturia Pro)">
        <p>
          Pro replaces your own key with hosted AI: the app sends your
          transcribed commands, and the content of any deck you load, through
          Capturia&rsquo;s proxy to Google Gemini (optionally via Cloudflare AI
          Gateway). That content transits the proxy and streams back to you; the
          proxy does not store or log prompts, transcripts, deck content, or
          model responses.
        </p>
        <p>
          What the hosted service does keep, in runtime state: your
          subscription&rsquo;s entitlement status keyed to its Stripe customer
          id, monthly token usage totals (counts, not content), short-lived
          rate-limit counters, hashed device credentials for the devices you
          activate, and one-time activation codes. There are no user accounts
          and no user database; Stripe is the customer record. Content
          forwarded to Google is processed under Google&rsquo;s terms.
        </p>
      </LegalSection>

      <LegalSection title="Payments">
        <p>
          Pro subscriptions are processed by Stripe. Checkout happens on
          Stripe&rsquo;s pages, and Capturia never sees your card number.
          Capturia receives from Stripe the identifiers and subscription status
          needed to switch Pro on and off for your purchase, nothing more. The
          payment details you enter at checkout are governed by Stripe&rsquo;s
          privacy policy.
        </p>
      </LegalSection>

      <LegalSection title="The website">
        <p>
          The hosted pages (the landing, the browser demo, the audience vote
          pages) use Vercel Web Analytics: cookieless page views plus a single
          custom event when a download button is clicked. No cookies, no
          cross-site tracking, no advertising identifiers. Audience voting asks
          your viewers for nothing but an anonymous tap: no sign-in, no name,
          no phone number.
        </p>
      </LegalSection>

      <LegalSection title="Changes and contact">
        <p>
          If a data flow changes, this page and its date change with it.
          Questions, or anything this page leaves unclear:{" "}
          <a href="mailto:capturia@andresio.com" className="cue-link">
            capturia@andresio.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalShell>
  );
}
