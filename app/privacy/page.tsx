import type { Metadata } from "next";
import LegalShell, { LegalSection } from "@/components/landing/LegalShell";

/* Privacy policy for the open-source build. Every claim in here is grounded
   in shipped code: key storage in electron/keychain.js, the local crash log in
   electron/crash-log.js, the GitHub update check in lib/update-check.ts, the
   vote backends in lib/vote-store.ts + lib/vote-backend.ts, and the demo-only
   rate-limit counters in lib/demo-gate.ts. If a data flow changes, this page
   changes in the same PR. */

const GITHUB = "https://github.com/AndresCarreonDiaz/capturia";
const ISSUES = "https://github.com/AndresCarreonDiaz/capturia/issues";

export const metadata: Metadata = {
  title: "Privacy Policy · Capturia",
  description:
    "No accounts, no telemetry, no analytics. Your API key stays on your machine and model calls go straight to your provider; shared demo servers keep only short-lived, salted rate-limit counters.",
};

export default function PrivacyPage() {
  return (
    <LegalShell eyebrow="Privacy" title="Privacy Policy" lastUpdated="August 18, 2026">
      <LegalSection title="The short version">
        <p>
          Capturia has no accounts, no sign-up, no user database, no telemetry,
          and no analytics. The app phones home to no one: its only outbound
          calls are your model calls, made on your own key, and a version check
          against the public GitHub API. The one exception, on shared demo
          servers only, is a short-lived rate-limit counter described below.
          The product is open source under MIT,
          so every claim on this page is verifiable in{" "}
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
          no call audio or video is sent anywhere. Only the transcribed
          command, and any deck you choose to load, go from your machine to the
          AI provider you configured, on your own key. What that provider does
          with your requests is governed by its own terms and privacy policy.
        </p>
        <p>
          The browser demo is the exception: dictation there is handled by your
          browser&rsquo;s built-in speech service, not on your machine. In
          Chrome that service sends your microphone audio to Google for
          recognition, governed by Google&rsquo;s privacy policy; Capturia
          receives only the resulting transcript.
        </p>
      </LegalSection>

      <LegalSection title="Your API key">
        <p>
          You supply your own AI key. In the desktop app it is encrypted on
          your Mac with a key held in the macOS Keychain; self-hosters can
          instead put a key in their own server environment. Either way it
          travels only to your model provider. There is no Capturia server,
          so it cannot be sent to or stored on one.
        </p>
      </LegalSection>

      <LegalSection title="No telemetry, no analytics">
        <p>
          The app sends no usage pings of any kind; the anonymous launch
          beacon that earlier builds carried has been removed entirely. The
          website serves static pages with no analytics script. If the app
          crashes, the crash log is a local file on your Mac that is never
          uploaded; you choose whether to attach it to a bug report.
        </p>
        <p>
          One narrow exception on shared demo deployments: to keep the free
          browser demo from being drained, the server may keep short-lived
          request counters keyed by a salted hash of your IP address. They
          expire within minutes, are never linked to what you say or do in
          the studio, and do not exist at all when you run Capturia yourself.
        </p>
      </LegalSection>

      <LegalSection title="The update check">
        <p>
          On launch the desktop app asks the public GitHub API whether a newer
          release exists. That request carries no identifiers beyond what any
          HTTP request carries, and it goes to GitHub, governed by
          GitHub&rsquo;s privacy policy. Updates are never downloaded or
          installed automatically; the app only points you at the releases
          page.
        </p>
      </LegalSection>

      <LegalSection title="Audience voting">
        <p>
          Vote rooms live in whatever server the deployer runs: in-memory in
          the server&rsquo;s own process by default, or a Redis instance the
          deployer supplies. Voting asks your viewers for nothing but an
          anonymous tap: no sign-in, no name, no phone number. Whoever hosts a
          vote page is the party handling those requests.
        </p>
      </LegalSection>

      <LegalSection title="Changes and contact">
        <p>
          If a data flow changes, this page and its date change with it.
          Questions, or anything this page leaves unclear:{" "}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer" className="cue-link">
            the GitHub issues page
          </a>
          .
        </p>
      </LegalSection>
    </LegalShell>
  );
}
