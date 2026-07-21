"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  collectActivationCode,
  parseCheckoutReturn,
  type PickupOutcome,
} from "@/lib/checkout-success";

// The landing-side half of the upgrade flow (M11 slice 2): Stripe redirects
// a paid checkout to /?checkout=success&session_id=...&pickup=..., and this
// overlay collects the one-time activation code and walks the buyer into the
// app. Renders nothing unless that exact redirect shape is present, so the
// landing stays byte-identical for everyone else. The code pickup is
// exactly-once server-side (GETDEL), hence the copy urging to store it now
// and the explicit already-collected state for refreshes.

type Phase = { kind: "loading" } | { kind: "done"; outcome: PickupOutcome };

export default function CheckoutSuccess() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const ret = parseCheckoutReturn(searchParams.toString());
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  // The pickup destroys the server record; run it once per mount even under
  // StrictMode's double-effect, and never let a late duplicate downgrade a
  // collected code.
  const started = useRef(false);
  // Dismissing cancels the poll, including the request already in flight.
  // The stakes are low either way (the server re-files a handed-out code
  // for a grace window, so nothing a dying poll does can burn it); this is
  // about not spending another minute of requests for an overlay nobody is
  // looking at.
  const abortRef = useRef<AbortController | null>(null);

  const sessionId = ret?.sessionId ?? null;
  const pickup = ret?.pickup ?? null;
  useEffect(() => {
    if (!sessionId || !pickup || started.current) return;
    started.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    collectActivationCode(
      { sessionId, pickup },
      { shouldAbort: () => controller.signal.aborted, signal: controller.signal }
    ).then((outcome) => {
      if (outcome.status === "aborted") return;
      setPhase((prev) =>
        prev.kind === "done" && prev.outcome.status === "ok" ? prev : { kind: "done", outcome }
      );
    });
  }, [sessionId, pickup]);

  if (!ret) return null;

  const dismiss = () => {
    abortRef.current?.abort();
    router.replace("/", { scroll: false });
  };
  const copy = (code: string) => {
    navigator.clipboard
      .writeText(code)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-[90] bg-black/80 backdrop-blur-md flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#0b0b0d] p-8 shadow-[0_0_80px_rgba(0,0,0,0.8)]">
        <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--phosphor)]">
          Capturia Pro
        </p>

        {phase.kind === "loading" && (
          <>
            <h2 className="display-serif mt-3 text-[var(--studio-ink)] text-2xl">
              Payment received. Minting your activation code…
            </h2>
            <p className="mt-3 text-[var(--studio-graphite)] text-[14px] leading-relaxed">
              This usually takes a few seconds.
            </p>
          </>
        )}

        {phase.kind === "done" && phase.outcome.status === "ok" && (
          <>
            <h2 className="display-serif mt-3 text-[var(--studio-ink)] text-2xl">
              You are in. Here is your activation code.
            </h2>
            <div className="mt-5 flex items-center gap-2">
              <code className="flex-1 rounded-lg border border-white/15 bg-white/5 px-4 py-3 font-mono text-[15px] tracking-wide text-[var(--studio-ink)] select-all">
                {phase.outcome.code}
              </code>
              <button
                onClick={() => copy(phase.outcome.status === "ok" ? phase.outcome.code : "")}
                className="cta-solid rounded-full px-5 py-3 text-[13px] font-semibold"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-4 text-[var(--studio-graphite)] text-[14px] leading-relaxed">
              This code is shown exactly once, so keep it until the app confirms
              activation. In Capturia: open Settings (⌘,), find the Capturia Pro
              row, paste the code, and hit Activate.
            </p>
          </>
        )}

        {phase.kind === "done" && phase.outcome.status === "gone" && (
          <>
            <h2 className="display-serif mt-3 text-[var(--studio-ink)] text-2xl">
              This code is no longer available here.
            </h2>
            <p className="mt-3 text-[var(--studio-graphite)] text-[14px] leading-relaxed">
              It was either already collected (each purchase shows its code
              once, usually right after payment) or this link has expired. If
              you did not save it, write to{" "}
              <a href="mailto:capturia@andresio.com" className="cue-link">
                capturia@andresio.com
              </a>{" "}
              from your purchase email and we will sort it out.
            </p>
          </>
        )}

        {phase.kind === "done" &&
          (phase.outcome.status === "error" || phase.outcome.status === "pending") && (
            <>
              <h2 className="display-serif mt-3 text-[var(--studio-ink)] text-2xl">
                Paid, but the code is taking longer than it should.
              </h2>
              <p className="mt-3 text-[var(--studio-graphite)] text-[14px] leading-relaxed">
                Your payment went through and nothing is lost. Refresh this page
                in a minute and the code will be waiting; if it still does not
                appear, write to{" "}
                <a href="mailto:capturia@andresio.com" className="cue-link">
                  capturia@andresio.com
                </a>
                .
              </p>
            </>
          )}

        <div className="mt-7 flex justify-end">
          <button
            onClick={dismiss}
            className="ghost-btn rounded-full px-5 py-2.5 text-[13px] font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
