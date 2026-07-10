"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  CopilotKitProvider,
  useAgentContext,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import { useAgentRun } from "@/hooks/useAgentRun";
import WebcamFeed from "@/components/WebcamFeed";
import OverlayLayer from "@/components/OverlayLayer";
import CommandBar from "@/components/CommandBar";
import LiveCaptions from "@/components/LiveCaptions";
import BrowserBanner from "@/components/BrowserBanner";
import ModelKeyBanner from "@/components/ModelKeyBanner";
import HudClock from "@/components/HudClock";
import AmbientParticles from "@/components/AmbientParticles";
// Real A2UI catalog object: createCatalog() is invoked at module load,
// registering every catalog component renderer (the 12 display overlays plus
// the interactive ActionButton) against the typed Zod definitions.
// Stashed on window for inspection; rendered live by Surface Mode (the A2UI
// renderer is loaded lazily via the dynamic import below, never on the server).
import { capturiaCatalog } from "@/lib/a2ui-catalog";

if (typeof window !== "undefined") {
  // Surface the catalog for inspection / live A2UI surface hosting.
  (window as unknown as { capturiaCatalog?: unknown }).capturiaCatalog = capturiaCatalog;
}

// Surface Mode renderer. @copilotkit/a2ui-renderer is client-only (createContext
// at module load), so its render path is code-split and loaded with ssr:false,
// keeping A2UIProvider/A2UIRenderer off the server. Only mounted when the
// operator opts into Surface Mode.
const A2uiOverlayLayer = dynamic(() => import("@/components/A2uiOverlayLayer"), {
  ssr: false,
  loading: () => null,
});
import { useStudioVoice } from "@/hooks/useStudioVoice";
import { useSpeechEnergy } from "@/hooks/useSpeechEnergy";
import { useStudioMirror } from "@/hooks/useStudioMirror";
import { controlRoomSearch, detectMirrorRole, type MirrorSnapshot } from "@/lib/mirror";
import { useVoteRoom } from "@/hooks/useVoteRoom";
import VoteQRBadge from "@/components/VoteQRBadge";
import { derivePollFromOverlays } from "@/lib/derive-poll";
import type { PollOption } from "@/lib/vote-store";
import { useRecorder } from "@/hooks/useRecorder";
import { useDesktopHotkey, useDesktopStateReport } from "@/hooks/useDesktopHotkey";
import { useKeyVault } from "@/hooks/useKeyVault";
import type { KeyProvider } from "@/hooks/useDesktopHotkey";
import SettingsModal from "@/components/SettingsModal";
import OnboardingFlow from "@/components/OnboardingFlow";
import DeckDropzone from "@/components/DeckDropzone";
import CueDeck from "@/components/CueDeck";
import { normalizeProps } from "@/lib/normalize";
import { sanitizeSurfaceTree } from "@/lib/a2ui-validate";
import { coerceArrayArg, coerceRecordArg, toolArgText } from "@/lib/extract-json";
import { oversizedToolArg } from "@/lib/limits";
import { isPlaceableOverlayType } from "@/lib/catalog";
import { matchCue, matchInterimCue, type InterimCueState } from "@/lib/deck/cues";
import type { CueCard, DeckFacts } from "@/lib/deck/types";
import type { OverlaySpec, OverlayPosition } from "@/lib/types";

// How long the fired-segment marker parked at a stop stays eligible for the
// trailing final. Apple-speech flushes ~100ms after a stop and Web Speech
// well under a second, while a human cannot finish speaking a NEW command
// that fast: the TTL is what keeps a quick-restarted session's first
// sentence (whose engine never delivers the old trailing final) from being
// swallowed by a stale marker.
const PARKED_CUE_TTL_MS = 800;

export default function Studio() {
  // Studio is fullscreen, so lock body scroll while mounted so the landing
  // page's scroll behavior doesn't bleed in.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // BYOK: which stored key drives the agent. The active provider is the user's
  // explicit pick, else the first provider with a saved key, else gemini.
  const vault = useKeyVault();
  const [pickedProvider, setPickedProvider] = useState<KeyProvider | null>(null);
  const firstWithKey = vault.keys.find((k) => k.has)?.provider;
  const activeProvider: KeyProvider = pickedProvider ?? firstWithKey ?? "gemini";

  // Desktop: main hosts the CopilotKit runtime on a loopback server and hands
  // the renderer its per-launch URL + bearer token over the bridge. The
  // plaintext BYOK key never crosses; the renderer only NAMES a provider and
  // main reads that key from the OS keychain itself. On web there is no
  // bridge, so this stays null and the /api/copilotkit route serves the
  // runtime. Must be STATE (like the old key plumbing): CopilotKit resolves
  // `headers` during render, so only a re-render propagates the token.
  const [desktopRuntime, setDesktopRuntime] = useState<{ url: string; token: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.capturia?.runtimeInfo?.()
      .then((info) => {
        if (!cancelled && info) setDesktopRuntime(info);
      })
      .catch(() => {
        /* runtime server down: dev still works via the Next route */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Desktop: name the active provider and authenticate to the loopback
  // runtime; the runtime's agents factory maps provider -> keychain key per
  // request. On web we send nothing and the route falls back to the env key.
  const headers = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {};
    if (desktopRuntime) {
      h["x-capturia-provider"] = activeProvider;
      h["x-capturia-token"] = desktopRuntime.token;
    }
    return h;
  }, [activeProvider, desktopRuntime]);

  const runtimeUrl = desktopRuntime?.url ?? "/api/copilotkit";

  // Remount (key) ONLY when the endpoint itself moves, which happens once at
  // startup when the desktop bridge reports the loopback runtime, before any
  // user interaction. Provider/key switches must still NOT remount: the v2
  // provider propagates `headers` changes in place (setHeaders effect applies
  // them to agents; runAgent re-stamps per run), and the v1 pattern of
  // key-remounting here wiped live overlays, the loaded deck, and the vote
  // room whenever the operator switched provider mid-session.
  return (
    <CopilotKitProvider
      key={runtimeUrl}
      runtimeUrl={runtimeUrl}
      headers={headers}
      // Both runtimes run in single-route mode (all methods POST to one endpoint).
      useSingleEndpoint
    >
      <Capturia
        vault={vault}
        activeProvider={activeProvider}
        setActiveProvider={setPickedProvider}
        headers={headers}
        runtimeUrl={runtimeUrl}
      />
    </CopilotKitProvider>
  );
}

interface CapturiaProps {
  vault: ReturnType<typeof useKeyVault>;
  activeProvider: KeyProvider;
  setActiveProvider: (p: KeyProvider) => void;
  // The same headers + endpoint CopilotKit sends to; the keycheck probe must
  // match them so it reports the health of the exact key path the agent uses.
  headers: Record<string, string>;
  runtimeUrl: string;
}

function Capturia({ vault, activeProvider, setActiveProvider, headers, runtimeUrl }: CapturiaProps) {
  // Mirror role, fixed by how the page was LOADED (not by the outputMode
  // toggle below): a ?out=1 page is a dedicated output surface (the desktop
  // app's offscreen camera window, a second same-browser tab) and RECEIVES
  // the visible Control Room's state over the mirror channel instead of
  // owning its own show. Everything a receiver must not do (publish state,
  // run the keycheck probe, publish a vote room, open agent runs from surface
  // taps, reveal operator chrome in place) is gated on this. Lazy init is
  // hydration-safe: the role never changes the first-paint DOM, only effects
  // and post-adoption renders.
  const [mirrorRole] = useState(() =>
    detectMirrorRole(typeof window === "undefined" ? "" : window.location.search)
  );
  const isMirrorReceiver = mirrorRole === "receiver";

  const [overlays, setOverlays] = useState<OverlaySpec[]>([]);
  const [lastSent, setLastSent] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const firstRunCheckedRef = useRef(false);
  // The full-screen stage; audio-reactivity publishes --mic-energy onto it.
  const stageRef = useRef<HTMLDivElement>(null);
  // v2 agent driver: sends the user turn through the AG-UI agent + core runAgent
  // so the registered frontend tools (useFrontendTool below) actually execute.
  // The ONLY useAgentRun call site (see that hook's header): CommandBar gets
  // sendMessage/busy as props so both input channels share one agent + thread.
  const { sendMessage, isRunning, runError } = useAgentRun();
  const { isRecording, startRecording, stopRecording } = useRecorder();

  // Surface the runtime's missing-key fail-fast in the operator UI. CopilotKit
  // swallows agent-run errors into the console, so without this probe a
  // keyless deployment looks alive while every command dies silently. Uses
  // the same headers + endpoint the agent requests use, so it reports the
  // health of the exact key path that will be used. On desktop the key lives
  // in main's keychain (not in headers), so saving/clearing a key changes
  // nothing the probe sends; the vault signature below is what re-runs it
  // through first-run onboarding (the CopilotKit key prop is runtimeUrl and
  // only changes once at startup, so no remount re-probes either).
  const [modelKeyError, setModelKeyError] = useState<string | null>(null);
  const vaultKeysSig = vault.keys.map((k) => `${k.provider}:${k.has ? 1 : 0}`).join(",");
  useEffect(() => {
    void vaultKeysSig; // re-probe when a key is saved or cleared
    // A mirror receiver never runs the agent and never shows ModelKeyBanner
    // (operator chrome is hidden in Program Output), so probing would be a
    // wasted POST; over file:// (the packaged offscreen window) the relative
    // route does not even exist.
    if (isMirrorReceiver) return;
    let cancelled = false;
    fetch(runtimeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ method: "capturia-keycheck" }),
    })
      .then((r) => r.json())
      .then((body: { error?: unknown }) => {
        if (!cancelled) setModelKeyError(typeof body?.error === "string" ? body.error : null);
      })
      .catch(() => {
        /* network/parse failure: the runtime's own calls will surface it */
      });
    return () => {
      cancelled = true;
    };
  }, [headers, runtimeUrl, vaultKeysSig, isMirrorReceiver]);

  // Deck state: cue cards to trigger, plus a compact view shared with the agent.
  const [cues, setCues] = useState<CueCard[]>([]);
  const [deckFacts, setDeckFacts] = useState<DeckFacts | null>(null);
  const [deckName, setDeckName] = useState<string | null>(null);
  const cuesRef = useRef<CueCard[]>([]);
  useEffect(() => {
    cuesRef.current = cues;
  }, [cues]);

  // Program Output: a chrome-free view (just webcam + overlays) that OBS or
  // the native Capturia camera captures as the published feed.
  const [outputMode, setOutputMode] = useState(false);

  // Surface Mode: render the SAME overlays through the real A2UI runtime
  // (A2UIProvider + <A2UIRenderer> + the registered capturiaCatalog) instead of
  // the direct React renderer. Opt-in so the AG-UI hot path stays the default.
  const [surfaceMode, setSurfaceMode] = useState(false);

  // Audio-reactive FX: default-on (the breathing IS part of the broadcast
  // look), but the cyan accent can clash with a stream's branding and some
  // talks want a static frame, so the operator can switch it off (FX pill) and
  // a captured output tab can pin it with ?fx=0. Off = the energy hook
  // never runs, so the vignette, BigCounter scale, and LiveBadge glow all stay
  // inert, not just the vignette layer.
  const [fxOn, setFxOn] = useState(true);

  // Audience voting: publish the live poll to this session's vote room, show
  // a QR on the FEED (it must survive Program Output: the audience scans it
  // off the published Zoom/Meet video), and mirror phone votes onto the tally.
  const [voteOn, setVoteOn] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("out") === "1") setOutputMode(true);
    if (params.get("surface") === "1") setSurfaceMode(true);
    if (params.get("fx") === "0") setFxOn(false);
    if (params.get("vote") === "1") setVoteOn(true);
  }, []);

  // Leaving Program Output on a RECEIVER is a NAVIGATION, never a state flip:
  // a receiver's local state is inert by design (the feed renders the adopted
  // snapshot), so flipping outputMode off in place would reveal operator
  // chrome whose commands run the real agent but can never render, a zombie
  // Control Room burning quota invisibly. Reloading without ?out=1 re-runs
  // role detection and boots this page as a genuine primary.
  const exitProgramOutput = useCallback(() => {
    if (isMirrorReceiver) {
      window.location.href =
        window.location.pathname + controlRoomSearch(window.location.search);
      return;
    }
    setOutputMode(false);
  }, [isMirrorReceiver]);

  // Cmd+, settings; Cmd/Ctrl+Shift+O clean Program Output; Cmd/Ctrl+Shift+A A2UI Surface Mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        // A receiver is ALWAYS in output mode, so the toggle can only mean
        // "leave", which for a receiver is the navigation above.
        if (isMirrorReceiver) exitProgramOutput();
        else setOutputMode((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSurfaceMode((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMirrorReceiver, exitProgramOutput]);

  // First-run: if desktop and no BYOK keys saved yet, open Settings once.
  // The onboarding tour owns this moment on a truly fresh install (its keys
  // step opens Settings itself); this fallback only fires for installs that
  // finished the tour and later cleared their keys.
  useEffect(() => {
    if (firstRunCheckedRef.current) return;
    if (!vault.isReady) return;
    firstRunCheckedRef.current = true;
    let onboarded = true;
    try {
      onboarded = window.localStorage.getItem("capturia:onboarded") === "1";
    } catch {
      // Storage unavailable: assume onboarded, the tour makes the same call.
    }
    if (onboarded && vault.isDesktop && !vault.keys.some((k) => k.has)) {
      setSettingsOpen(true);
    }
  }, [vault.isReady, vault.isDesktop, vault.keys]);

  // Apply a cue card's pre-built overlays (merge by id, like add_overlay).
  const applyCue = useCallback((card: CueCard) => {
    setOverlays((prev) => {
      const ids = new Set(card.specs.map((s) => s.id));
      const kept = prev.filter((o) => !ids.has(o.id));
      return [...kept, ...card.specs];
    });
  }, []);

  // Continuous voice can finish transcribing a second command while the
  // agent still renders the first. sendMessage drops mid-run turns by design
  // (v2's runAgent CANCELS an active run instead of queueing, which would
  // truncate the streaming turn's tool calls mid-render), so instead of
  // losing the command, the newest dropped one parks here and fires when the
  // run settles. Depth 1 on purpose: the freshest command is what the
  // speaker most recently wanted; anything older is stale narration.
  const pendingVoiceRef = useRef<string | null>(null);

  // Interim cue-matching state for the CURRENT speech segment (cards already
  // fired, candidate awaiting confirmation). The engines close segments via
  // onSegmentEnd; a ref because it lives inside speech event callbacks.
  const interimCueRef = useRef<InterimCueState | null>(null);

  // Fired-segment marker parked at a stop transition. Both engines deliver
  // a trailing final AFTER a stop by design, and a quick restart resets the
  // live ref before that final lands; the parked marker lets it still know
  // the segment was answered (else it would re-answer the sentence through
  // the agent). A segment end or the TTL discards it.
  const parkedCueRef = useRef<{ at: number } | null>(null);

  // Listening state visible to the speech callbacks without waiting on a
  // re-render (they need to tell a live session's interim from a dying
  // session's trailing one).
  const isListeningRef = useRef(false);

  // Cue ids are per-deck (cue-<slideIndex>), so a deck swap mid-segment would
  // let a stale fired list poison the new deck's identical ids and silently
  // swallow the sentence final. New deck, clean segment.
  useEffect(() => {
    interimCueRef.current = null;
    parkedCueRef.current = null;
  }, [cues]);

  const { isListening, interimTranscript, speechStatus, lastError, lastResultAt, isSupported, startListening, stopListening } =
    useStudioVoice(
      (text) => {
        // Capture before closing the segment: a fired segment was already
        // answered deterministically mid-sentence, so its final is swallowed
        // outright (one utterance, one response; a rescored final could
        // otherwise re-answer through the agent). A quick stop/start wipes
        // the live ref before the trailing final lands, so the stop
        // transition parks a TTL'd marker as the fallback signal.
        const parked = parkedCueRef.current;
        parkedCueRef.current = null;
        const firedMidSentence =
          Boolean(interimCueRef.current?.firedId) ||
          (parked !== null && performance.now() - parked.at < PARKED_CUE_TTL_MS);
        interimCueRef.current = null;
        if (text.split(/\s+/).length < 2) return;
        setLastSent(text);
        if (firedMidSentence) return;
        // Deterministic, offline cue match first: "show my revenue slide" fires a
        // pre-built card without a model call. Falls through to the agent on miss.
        const card = matchCue(cuesRef.current, text);
        if (card) {
          applyCue(card);
          return;
        }
        sendMessage(`[VOICE] ${text}`)
          .then((sent) => {
            if (!sent) pendingVoiceRef.current = text;
          })
          .catch(() => {});
      },
      (interim) => {
        // A volatile hypothesis has no business firing UI after the mic was
        // toggled off, and a dying session's trailing interim must not
        // reseed state its own trailing final is about to consume. The
        // parked marker is deliberately NOT cleared here: after a quick
        // restart an old session's interim is indistinguishable from a new
        // one, and the short TTL already bounds the marker's life.
        if (!isListeningRef.current) return;
        // Mid-sentence: fire a primed cue card once the volatile hypothesis
        // confirms one of its aliases (two consecutive wins; see
        // matchInterimCue). This is the M9 payoff: PDF-primed UI lands while
        // the speaker is still talking, no model call, no waiting for the
        // sentence final.
        const { fire, state } = matchInterimCue(cuesRef.current, interim, interimCueRef.current);
        interimCueRef.current = state;
        if (fire) applyCue(fire);
      },
      () => {
        // Segment boundary with no final attached (filtered hallucination,
        // recognizer cycle restart, session error/done): drop the dedup
        // state so the next sentence starts clean. Boundaries WITH a final
        // were already reset above; this second write is a no-op then. The
        // segment is truly closed, so no trailing final is owed the parked
        // state either.
        interimCueRef.current = null;
        parkedCueRef.current = null;
      }
    );

  // Listening transitions are segment boundaries with one nuance: both
  // engines deliver a trailing final AFTER a stop by design, and that final
  // must still know the segment already fired or a rescored sentence would
  // double-respond through the agent. So a STOP parks a TTL'd marker
  // (consumed by the trailing final, discarded by a segment end) while a
  // START clears the live state outright: a quick stop/start on the
  // apple-speech engine can drop the aborted segment's closing events
  // entirely, and stale live state would swallow the new session's first
  // command. The parked marker deliberately survives a START (a web
  // trailing final can land after a quick restart); the short TTL is what
  // keeps it from ever swallowing a new session's first sentence.
  useEffect(() => {
    isListeningRef.current = isListening;
    if (!isListening && interimCueRef.current?.firedId) {
      parkedCueRef.current = { at: performance.now() };
    }
    interimCueRef.current = null;
  }, [isListening]);

  // Flush the parked voice command once the agent run settles.
  useEffect(() => {
    if (isRunning) return;
    const parked = pendingVoiceRef.current;
    if (!parked) return;
    pendingVoiceRef.current = null;
    sendMessage(`[VOICE] ${parked}`)
      .then((sent) => {
        if (!sent) pendingVoiceRef.current = parked;
      })
      .catch(() => {});
  }, [isRunning, sendMessage]);

  // Desktop push-to-talk: Cmd+Alt+Space toggles voice from anywhere on the OS.
  useDesktopHotkey("toggle-voice", () => {
    if (!isSupported) return;
    if (isListening) stopListening();
    else startListening();
  });

  // Desktop tray: the Settings menu item rides the same channel as hotkeys.
  useDesktopHotkey("open-settings", () => setSettingsOpen(true));

  // Mirror voice state to the tray (Listening/Idle status, toggle enablement).
  useDesktopStateReport({ listening: isListening, voiceSupported: isSupported });

  // The poll currently on screen (first authored surface with ActionButtons);
  // see lib/derive-poll.ts. Memoized so the vote-room publish effect keys off
  // real content changes, not render churn.
  const livePoll = useMemo(() => derivePollFromOverlays(overlays), [overlays]);

  // Mirror the room's ABSOLUTE counts onto the broadcast tally. Deterministic
  // on purpose (no agent turn per vote): a room of phones voting would melt
  // the one-turn-at-a-time agent loop, while MetricsPanel animates value
  // changes regardless of who set them. Creates the tally if the agent's poll
  // turn forgot it.
  const applyAudienceCounts = useCallback(
    (counts: Record<string, number>, options: PollOption[]) => {
      setOverlays((prev) => {
        const existing = prev.find((o) => o.id === "poll-tally");
        if (!existing) {
          return [
            ...prev,
            {
              id: "poll-tally",
              type: "MetricsPanel",
              position: "top-right",
              props: {
                title: "Live votes",
                metrics: options.map((opt) => ({
                  label: opt.label,
                  value: String(counts[opt.actionName] ?? 0),
                })),
              },
            } as OverlaySpec,
          ];
        }
        return prev.map((o) => {
          if (o.id !== "poll-tally" || o.type !== "MetricsPanel") return o;
          // Rebuild the rows from the poll's options keyed by actionName, the
          // server's own vote currency. Matching existing rows by label broke
          // when the tally's row labels differed from the button labels or two
          // options shared a label. MetricsPanel still animates value changes
          // because it keys its count-up on the (stable) row label.
          const metrics = options.map((opt) => ({
            label: opt.label,
            value: String(counts[opt.actionName] ?? 0),
          }));
          return { ...o, props: { ...o.props, metrics } };
        });
      });
    },
    []
  );

  // Surfaces a rejected poll publish (bad poll, room taken, room full) so the
  // operator knows why the on-feed QR is showing an empty room, instead of the
  // failure being swallowed.
  const [votePublishError, setVotePublishError] = useState<string | null>(null);
  const { voteUrl, castHostVote } = useVoteRoom({
    // A mirror receiver must never publish a vote room of its own: its
    // mirrored overlays would derive the same poll and claim a second room
    // nobody's phones are in. It shows the PRIMARY's QR instead (below).
    enabled: voteOn && !isMirrorReceiver,
    poll: livePoll,
    onCounts: applyAudienceCounts,
    onPublishError: setVotePublishError,
  });

  // Mirror channel: the Control Room (primary) publishes its live broadcast
  // state; a ?out=1 page (the desktop app's offscreen camera window, a second
  // same-browser tab) adopts it. Full protocol rationale in lib/mirror.ts.
  // The snapshot is memoized so the hook's republish effect fires on real
  // state changes, not render churn.
  const mirrorSnapshot = useMemo<MirrorSnapshot>(
    () => ({
      overlays,
      surfaceMode,
      fxOn,
      listening: isListening && fxOn,
      voteUrl: voteOn ? voteUrl : null,
    }),
    [overlays, surfaceMode, fxOn, isListening, voteOn, voteUrl]
  );
  const mirror = useStudioMirror({
    role: mirrorRole,
    snapshot: mirrorSnapshot,
    speakAt: lastResultAt,
  });

  // What the FEED renders. A receiver ignores its own (empty) state wholesale
  // in favor of the adopted snapshot, so mirroring stays one-directional by
  // construction: nothing a receiver does locally can reach the feed or leak
  // back. Until the first snapshot lands it shows the bare webcam, exactly
  // what the camera page showed before mirroring existed.
  const feedOverlays = isMirrorReceiver ? mirror.adopted?.overlays ?? [] : overlays;
  const feedSurfaceMode = isMirrorReceiver
    ? mirror.adopted?.surfaceMode ?? false
    : surfaceMode;
  // FX on a receiver needs BOTH switches: the mirrored master (the operator's
  // FX pill) and the local ?fx=0 pin, so an OBS scene pinned static stays
  // static even while the Control Room breathes.
  const feedFxOn = isMirrorReceiver ? fxOn && (mirror.adopted?.fxOn ?? true) : fxOn;
  // Room ids are minted per tab (useVoteRoom), so a receiver must show the
  // primary's QR verbatim; its own room would tally nobody.
  const feedVoteUrl = isMirrorReceiver ? mirror.adopted?.voteUrl ?? null : voteOn ? voteUrl : null;

  // Audio-reactive: publish a 0..1 speaking-energy to --mic-energy on the stage
  // root (derived from Web Speech RESULT events, NO AudioContext, so it never
  // fights voice). The feed breathes as the speaker talks via the .energy-*
  // CSS rules. The FX pill / ?fx=0 lets the operator pin a static frame. A
  // mirror receiver has no speech engine, so its envelope runs off the
  // primary's throttled speak pings instead, through the exact same easing.
  useSpeechEnergy({
    targetRef: stageRef,
    lastResultAt: isMirrorReceiver ? mirror.adoptedSpeakAt : lastResultAt,
    isListening: isMirrorReceiver
      ? Boolean(mirror.adopted?.listening) && fxOn
      : isListening && fxOn,
  });

  // Dev-only E2E driver: lets Playwright (and the desktop camera harness in
  // scripts/e2e-desktop-camera.mjs) place overlays without a live model turn,
  // since the real agent path is key-gated. NODE_ENV is inlined at build
  // time, so production bundles compile this whole effect away.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as {
      capturiaDrive?: { setOverlays: (specs: OverlaySpec[]) => void };
    };
    w.capturiaDrive = {
      setOverlays: (specs) => setOverlays(Array.isArray(specs) ? specs : []),
    };
    return () => {
      delete w.capturiaDrive;
    };
  }, []);

  // Closed loop: a tap on an interactive leaf (ActionButton) inside an
  // agent-authored surface arrives here via A2uiOverlayLayer's onAction. Re-inject
  // it as an "[ACTION] <name>" user turn, exactly like the [VOICE] path above, so
  // the agent responds by changing the scene with its tools (see ACTION rules in
  // the system prompt). Dedupe a click-storm so a rapid double-tap can't spin the
  // agent on the same action.
  const lastActionRef = useRef<{ name: string; t: number }>({ name: "", t: 0 });
  const handleSurfaceAction = useCallback(
    (action: { name: string }) => {
      const name = (action?.name || "").trim();
      if (!name) return;
      // Audience voting on: a tap on a poll button is a VOTE, not an agent
      // turn. The server tallies it like any phone vote and the counts flow
      // back over SSE, so host taps and audience votes can never diverge.
      if (castHostVote(name)) {
        setLastSent(`[VOTE] ${name}`);
        return;
      }
      // Mid-run taps are dropped INSIDE sendMessage (checked live on the agent
      // instance, immune to the stale-closure window before React re-renders
      // isRunning): v2's runAgent cancels an in-flight run instead of queueing.
      // The agent re-renders the surface after it responds, so a dropped tap is
      // a no-op, not lost UX (and [data-agent-busy] CSS disables the buttons
      // while running, so this is belt-and-suspenders).
      const now = Date.now();
      if (lastActionRef.current.name === name && now - lastActionRef.current.t < 600) return;
      lastActionRef.current = { name, t: now };
      setLastSent(`[ACTION] ${name}`);
      // Keep the catch so an unexpected run rejection can never crash the studio.
      sendMessage(`[ACTION] ${name}`).catch(() => {});
    },
    [sendMessage, castHostVote]
  );

  // AG-UI Shared State: agent always knows what's currently on screen
  useAgentContext({
    description:
      "Current overlay components on the live video feed. Each has an id, type, position, and props.",
    // Cast: the shape is JSON-serializable at runtime (plain objects/arrays of
    // strings/numbers), but the catalog prop types lack the index signatures
    // TS's JsonSerializable requires.
    value: overlays.map((o) => ({
      id: o.id,
      type: o.type,
      position: o.type !== "Letterbox" ? o.position : "full-screen",
      // Authored surfaces carry a whole component tree; summarize it instead of
      // echoing the full node list back into the agent's context every render.
      // DO list the live ActionButtons: on an "[ACTION] <name>" turn the model
      // needs the full set of buttons it authored (names + labels) to map the
      // tap to the right response without inventing different actionNames.
      props:
        o.type === "Surface"
          ? {
              components: `<authored A2UI tree, ${o.props.components.length} nodes>`,
              actions: o.props.components
                .filter((n) => n.component === "ActionButton")
                .map((n) => ({ actionName: String(n.actionName ?? ""), label: String(n.label ?? "") })),
            }
          : o.props,
    })) as unknown as Parameters<typeof useAgentContext>[0]["value"],
  });

  // Deck priming: the agent uses the speaker's real titles/numbers/names as the
  // source of truth, so spoken metrics render with deck values, not invented ones.
  useAgentContext({
    description:
      "Loaded pitch deck (if any). Slide titles, bullets, detected numbers (label/value), and names. When the speaker mentions something that appears here, render it using THESE exact values. Never invent numbers that contradict the deck.",
    value: (deckFacts ?? null) as unknown as Parameters<typeof useAgentContext>[0]["value"],
  });

  // NOTE on all 8 tool registrations below:
  // - useFrontendTool registers the FIRST render's tool object permanently
  //   (its effect never re-registers on re-render), so handlers are frozen
  //   mount-time closures. They must only touch state through functional
  //   setState and module-level helpers, never read component state directly;
  //   pass the hook's deps argument if that ever becomes necessary.
  // - The z.string() params carrying JSON are advisory to the model, not
  //   enforced at runtime: Gemini sometimes emits them PRE-PARSED (nested
  //   object/array), so every JSON-carrying param goes through the coerce
  //   helpers instead of a bare JSON.parse.

  // A2UI Action: add a new spatial overlay component
  useFrontendTool({
    name: "add_overlay",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description:
      "Add a new overlay component to the live video feed. Use the A2UI catalog component types and positions.",
    parameters: z.object({
      id: z.string().describe("Unique id like 'metrics-1' or 'lower-third-main'"),
      type: z
        .string()
        .describe(
          "Component type: MetricsPanel | Timeline | LowerThird | ProgressBar | KeywordHighlight | FloatingChart | ChatBubble | Letterbox | Ticker | LiveBadge | StatRing | BigCounter | CountdownTimer"
        ),
      position: z
        .string()
        .optional()
        .describe(
          "Anchor: top-left | top-right | top-center | center-left | center-right | bottom-left | bottom-right | bottom-center | full-bottom (omit for Letterbox)"
        ),
      props: z
        .string()
        .describe("JSON string of component-specific props matching the catalog schema"),
    }),
    handler: async ({ id, type, position, props: propsStr }) => {
      if (oversizedToolArg(toolArgText(propsStr))) return;
      const props = coerceRecordArg(propsStr);
      if (!props) {
        console.warn("add_overlay: invalid props JSON, ignoring");
        return;
      }
      // Surfaces are only ever created through render_surface, whose handler
      // runs sanitizeSurfaceTree. Reject here so a "Surface" type can't smuggle
      // an unsanitized component tree (cycles, oversized, bindings) into state.
      if (type === "Surface") {
        console.warn("add_overlay cannot create a Surface; use render_surface");
        return;
      }
      // Unknown types render nothing; surface-only types (ActionButton) would
      // render a dead button outside the interactive render_surface host.
      if (!isPlaceableOverlayType(type)) {
        console.warn(`add_overlay: '${type}' is not a placeable overlay type, ignoring`);
        return;
      }
      const normalized = normalizeProps(type, props);
      setOverlays((prev) => {
        const filtered = prev.filter((o) => o.id !== id);
        return [
          ...filtered,
          { id, type, position: position as OverlayPosition, props: normalized } as OverlaySpec,
        ];
      });
    },
  });

  // A2UI Action: modify an existing overlay's props
  useFrontendTool({
    name: "modify_overlay",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description: "Update props of an existing overlay without changing its type or position.",
    parameters: z.object({
      id: z.string().describe("The id of the overlay to modify"),
      props: z.string().describe("New props as JSON string (merged with existing props)"),
    }),
    handler: async ({ id, props: propsStr }) => {
      if (oversizedToolArg(toolArgText(propsStr))) return;
      const newProps = coerceRecordArg(propsStr);
      if (!newProps) return;
      setOverlays((prev) =>
        prev.map((o) => {
          // Never let modify_overlay touch a Surface: its props are a sanitized
          // component tree, not flat leaf props. Re-author via render_surface.
          if (o.id !== id || o.type === "Surface") return o;
          const merged = { ...(o.props as Record<string, unknown>), ...newProps };
          const normalized = normalizeProps(o.type, merged);
          return { ...o, props: normalized } as OverlaySpec;
        })
      );
    },
  });

  // A2UI Action: remove an overlay
  useFrontendTool({
    name: "remove_overlay",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description: "Remove an overlay from the video by id. Use 'all' to remove every overlay.",
    parameters: z.object({
      id: z.string().describe("The overlay id to remove, or 'all' to remove every overlay"),
    }),
    handler: async ({ id }) => {
      if (id === "all") {
        setOverlays([]);
      } else {
        setOverlays((prev) => prev.filter((o) => o.id !== id));
      }
    },
  });

  // A2UI Action: smoothly relocate an overlay to a new anchor position
  useFrontendTool({
    name: "move_overlay",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description:
      "Move an existing overlay to a new anchor position. The overlay slides smoothly between positions. Cannot be used on Letterbox.",
    parameters: z.object({
      id: z.string().describe("The overlay id to move"),
      position: z
        .string()
        .describe(
          "New anchor: top-left | top-right | top-center | center-left | center-right | bottom-left | bottom-right | bottom-center | full-bottom"
        ),
    }),
    handler: async ({ id, position }) => {
      setOverlays((prev) =>
        prev.map((o) => {
          if (o.id !== id || o.type === "Letterbox") return o;
          return { ...o, position: position as OverlayPosition } as OverlaySpec;
        })
      );
    },
  });

  // A2UI Action: append values to a FloatingChart's data array (live-growing chart)
  useFrontendTool({
    name: "append_chart_data",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description:
      "Append one or more numeric values to a FloatingChart's data series. Use to grow charts over time as new data points come in. Pass values as a JSON array of numbers, e.g. '[42, 47, 51]'.",
    parameters: z.object({
      id: z.string().describe("The FloatingChart id"),
      values: z.string().describe("JSON array of numbers to append, e.g. '[42, 47]'"),
    }),
    handler: async ({ id, values: valuesStr }) => {
      if (oversizedToolArg(toolArgText(valuesStr))) return;
      const values = coerceArrayArg(valuesStr)
        .map((v) => (typeof v === "number" ? v : Number(v)))
        .filter((v) => Number.isFinite(v));
      if (values.length === 0) return;
      setOverlays((prev) =>
        prev.map((o) => {
          if (o.id !== id || o.type !== "FloatingChart") return o;
          const next = [...o.props.data, ...values].slice(-30);
          return { ...o, props: { ...o.props, data: next } };
        })
      );
    },
  });

  // A2UI Action: update a single metric row in a MetricsPanel
  useFrontendTool({
    name: "bump_metric",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description:
      "Update a single metric row in an existing MetricsPanel by label. The new value count-ups smoothly and the row flashes green/red based on direction. Use this to show live KPI changes.",
    parameters: z.object({
      id: z.string().describe("The MetricsPanel id"),
      label: z.string().describe("The metric row label to update"),
      value: z.string().describe("New value, e.g. '$1.2M' or '47%'"),
      delta: z
        .string()
        .optional()
        .describe("Optional new delta, e.g. '+12%' or '-3'. Pass empty string to clear."),
    }),
    handler: async ({ id, label, value, delta }) => {
      setOverlays((prev) =>
        prev.map((o) => {
          if (o.id !== id || o.type !== "MetricsPanel") return o;
          const metrics = o.props.metrics.map((m) =>
            m.label === label
              ? { ...m, value, ...(delta !== undefined ? { delta: delta || undefined } : {}) }
              : m
          );
          return { ...o, props: { ...o.props, metrics } };
        })
      );
    },
  });

  // A2UI Action: compose a WHOLE scene in one call. The "push a whole UI at once"
  // counterpart to single add_overlay calls, used when the speaker sets up or
  // lays out several components together (an intro, a results screen). Merges by
  // id like add_overlay; replace=true wipes the stage first for a fresh scene.
  // Renders identically in both the direct and A2UI Surface Mode renderers.
  useFrontendTool({
    name: "compose_scene",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description:
      "Compose a whole overlay scene in ONE call. Prefer this over multiple add_overlay calls when the user sets up, lays out, or shows several components together (e.g. an intro: LowerThird + LiveBadge + MetricsPanel). Pass `elements` as a JSON array; each item is { id, type, position?, props } using the same catalog types, positions, and prop shapes as add_overlay. Set replace=true to clear all existing overlays first (use when starting a fresh scene).",
    parameters: z.object({
      elements: z
        .string()
        .describe(
          'JSON array of overlays, e.g. [{"id":"lt-1","type":"LowerThird","position":"bottom-left","props":{"name":"Alex","subtitle":"Founder, Acme"}},{"id":"live-1","type":"LiveBadge","position":"top-left","props":{}}]'
        ),
      replace: z
        .boolean()
        .optional()
        .describe(
          "If true, remove all existing overlays before adding this scene. Default false (merge by id)."
        ),
    }),
    handler: async ({ elements, replace }) => {
      if (oversizedToolArg(toolArgText(elements))) return;
      const parsed = coerceArrayArg(elements);
      if (parsed.length === 0) {
        console.warn("compose_scene: invalid or empty elements, ignoring");
        return;
      }
      const specs: OverlaySpec[] = [];
      for (const raw of parsed) {
        if (!raw || typeof raw !== "object") continue;
        const it = raw as Record<string, unknown>;
        if (typeof it.id !== "string" || typeof it.type !== "string") continue;
        // Surfaces must go through render_surface (sanitizeSurfaceTree); skip any
        // that try to ride in via compose_scene unsanitized. Same for unknown
        // and surface-only types (ActionButton only works inside surfaces).
        if (it.type === "Surface" || !isPlaceableOverlayType(it.type)) continue;
        const props = normalizeProps(
          it.type,
          (it.props && typeof it.props === "object" ? it.props : {}) as Record<string, unknown>
        );
        specs.push({
          id: it.id,
          type: it.type,
          position: it.position as OverlayPosition,
          props,
        } as OverlaySpec);
      }
      if (specs.length === 0) return;
      setOverlays((prev) => {
        const base = replace ? [] : prev;
        const incoming = new Set(specs.map((s) => s.id));
        const kept = base.filter((o) => !incoming.has(o.id));
        return [...kept, ...specs];
      });
    },
  });

  // A2UI Action: render an AGENT-AUTHORED surface. Unlike add_overlay/compose_scene
  // (which place fixed leaf overlays), here the model authors a whole A2UI v0.9
  // component tree, composing branded Capturia overlays inside layout primitives.
  // The tree is sanitized (sanitizeSurfaceTree) before it touches state, then
  // rendered through the genuine A2UI runtime by a dedicated A2uiOverlayLayer.
  useFrontendTool({
    name: "render_surface",
    // Fire-and-forget: the overlay IS the output; no tool-result round trip.
    followUp: false,
    description:
      "Author a custom A2UI surface: a composed component tree (layout primitives wrapping Capturia overlays) rendered through the live A2UI runtime. Use this ONLY when you need several overlays grouped into ONE laid-out unit (e.g. a stacked stat block). For a single overlay use add_overlay; for several independently anchored overlays use compose_scene. `components` is a JSON array of flat A2UI v0.9 nodes: the root node MUST have id \"root\" and be a Column, Row, or List; children are referenced by id arrays; props are top-level keys; allowed components are the layout primitives Column/Row/List/Divider plus the Capturia catalog types, including the interactive ActionButton {label, actionName} whose taps come back to you as '[ACTION] <actionName>' turns.",
    parameters: z.object({
      id: z.string().describe("Unique surface id like 'surface-intro' or 'stat-block'"),
      position: z
        .string()
        .optional()
        .describe(
          "Anchor: top-left | top-right | top-center | center-left | center-right | bottom-left | bottom-right | bottom-center | full-bottom"
        ),
      components: z
        .string()
        .describe(
          'JSON array of A2UI v0.9 flat nodes. Example: [{"id":"root","component":"Column","children":["lt","mp"]},{"id":"lt","component":"LowerThird","name":"Alex","subtitle":"Founder, Acme"},{"id":"mp","component":"MetricsPanel","title":"Q4","metrics":[{"label":"Revenue","value":"$1.8M","delta":"+24%"}]}]'
        ),
    }),
    handler: async ({ id, position, components }) => {
      // The model may hand back the tree already-parsed, fenced (```json …```),
      // or wrapped in prose; the coerce helpers tolerate all. The size cap
      // covers the pre-parsed case too (toolArgText stringifies it), or a
      // structured arg would bypass it entirely and lean on the sanitizer's
      // node/depth bounds alone.
      if (oversizedToolArg(toolArgText(components))) return;
      const tree = sanitizeSurfaceTree(coerceArrayArg(components));
      if (!tree) {
        // A rejected tree is handled (we ignore it), not a crash, so warn rather
        // than error — console.error pops the Next.js dev error overlay.
        console.warn("render_surface: components missing or invalid, ignoring");
        return;
      }
      setOverlays((prev) => {
        const filtered = prev.filter((o) => o.id !== id);
        return [
          ...filtered,
          {
            id,
            type: "Surface",
            position: (position as OverlayPosition) ?? "center-right",
            props: { components: tree },
          } as OverlaySpec,
        ];
      });
    },
  });

  // Leaf overlays render through the active renderer (direct React, or the A2UI
  // host when Surface Mode is on). Authored surfaces ALWAYS need the A2UI host, so
  // they render through their own dedicated A2uiOverlayLayer regardless of the
  // Surface Mode toggle, kept separate so toggling modes never re-animates the
  // leaf overlays, and the surface layer is always mounted so a removed surface's
  // 320ms exit animation plays out before its provider would tear down.
  // Split from feedOverlays so a mirror receiver renders the adopted state.
  const leafOverlays = feedOverlays.filter((o) => o.type !== "Surface");
  const surfaceOverlays = feedOverlays.filter((o) => o.type === "Surface");

  return (
    <div
      ref={stageRef}
      // While a turn runs, [data-agent-busy] CSS dims + disables authored
      // ActionButtons so a dropped tap reads as "thinking", not broken.
      data-agent-busy={isRunning ? "" : undefined}
      className={`relative w-screen h-screen bg-black overflow-hidden ${
        isListening && !outputMode ? "mic-glow" : ""
      }`}
    >
      {/* Layer 0: webcam */}
      <WebcamFeed />

      {/* Layer 0.4: audio-reactive vignette. Breathes with --mic-energy (set by
          useSpeechEnergy from speech results, or from mirrored speak pings on
          a receiver). Stays in Program Output since the breathing IS part of
          the broadcast look; inert (energy 0) when idle and unmounted entirely
          when FX are off. */}
      {feedFxOn && <div className="energy-vignette" aria-hidden />}

      {/* Layer 0.45: audience-voting QR. Part of the BROADCAST look on purpose:
          Zoom/Meet viewers scan it off the published feed, so it must survive
          Program Output. On a mirror receiver this is the PRIMARY's room. */}
      {feedVoteUrl && <VoteQRBadge url={feedVoteUrl} />}

      {/* Layer 0.5: ambient floating particles when voice is active (hidden in clean output) */}
      {!outputMode && <AmbientParticles active={isListening} />}

      {/* Layer 1: leaf overlays (the published feed). Surface Mode renders these
          through the live A2UI runtime; default is the direct React renderer.
          Both read the one `overlays` source of truth. */}
      {feedSurfaceMode ? (
        <A2uiOverlayLayer overlays={leafOverlays} />
      ) : (
        <OverlayLayer overlays={leafOverlays} />
      )}

      {/* Layer 1b: agent-authored surfaces (render_surface). These ARE A2UI
          trees, so they always render through their own A2UI host, independent
          of the Surface Mode toggle. Always mounted so exit animations finish.
          onSurfaceAction closes the loop: a tap on an authored ActionButton is
          re-injected as an [ACTION] turn so the agent can respond live. A
          mirror receiver gets NO handler: its copy of the surface must never
          open agent runs or cast votes (the Control Room owns interaction). */}
      <A2uiOverlayLayer
        overlays={surfaceOverlays}
        onSurfaceAction={isMirrorReceiver ? undefined : handleSurfaceAction}
      />

      {/* Everything below is operator chrome, hidden in Program Output so OBS /
          the virtual camera capture only the webcam + overlays. */}
      {!outputMode && (
        <>
          {/* First-run tour (desktop only, once per install). Non-modal on
              purpose: the stage behind it IS the "what your audience sees"
              demo, and the voice step needs the hotkey live. */}
          <OnboardingFlow
            ctx={{
              isDesktop: vault.isDesktop,
              hasKeys: vault.keys.some((k) => k.has),
              voiceSupported: isSupported,
              overlayCount: overlays.length,
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {/* Layer 2: live voice captions */}
          <LiveCaptions
            text={interimTranscript}
            lastSent={lastSent}
            speechStatus={speechStatus}
            lastError={lastError}
            isListening={isListening}
          />

          {/* Operator notices, stacked so several can show at once. top-28
              clears the CueDeck header (top-16 left-4) on narrow viewports. */}
          {(() => {
            const voteUrlUnreachable =
              voteOn && !!voteUrl && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(voteUrl);
            const publishError = voteOn ? votePublishError : null;
            if (!(!isSupported || modelKeyError || voteUrlUnreachable || publishError || runError))
              return null;
            return (
              <div className="absolute top-28 left-1/2 -translate-x-1/2 z-40 w-[min(92vw,30rem)] flex flex-col gap-2">
                {/* Agent has no model key: nothing will render until fixed. */}
                {modelKeyError && <ModelKeyBanner message={modelKeyError} />}
                {/* Honest heads-up when voice can't run here (Firefox/Brave/desktop). */}
                {!isSupported && <BrowserBanner />}
                {/* An agent run failed (rate limit, revoked key, server 503).
                    runAgent swallows these into subscribers, so without this
                    notice the loop just goes silently dead mid-show. Cleared
                    by the next successful send. */}
                {runError && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-black/70 px-4 py-3 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
                    <span
                      aria-hidden
                      className="mt-0.5 h-2 w-2 flex-none rounded-full bg-amber-400"
                      style={{ boxShadow: "0 0 8px #fbbf24" }}
                    />
                    <div className="text-[13px] leading-snug text-white/80">
                      <span className="font-semibold text-white">Agent run failed:</span>{" "}
                      {runError}
                    </div>
                  </div>
                )}
                {/* The room rejected the poll: the QR is live but votes go
                    nowhere until the operator knows why. */}
                {publishError && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-black/70 px-4 py-3 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
                    <span
                      aria-hidden
                      className="mt-0.5 h-2 w-2 flex-none rounded-full bg-amber-400"
                      style={{ boxShadow: "0 0 8px #fbbf24" }}
                    />
                    <div className="text-[13px] leading-snug text-white/80">
                      <span className="font-semibold text-white">Audience vote not published:</span>{" "}
                      {publishError}. The QR is live but votes won&apos;t register until this clears.
                    </div>
                  </div>
                )}
                {/* The vote QR points at localhost: phones (and Zoom viewers)
                    can't reach it. Operator-only; the QR itself stays clean. */}
                {voteUrlUnreachable && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-black/70 px-4 py-3 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
                    <span
                      aria-hidden
                      className="mt-0.5 h-2 w-2 flex-none rounded-full bg-amber-400"
                      style={{ boxShadow: "0 0 8px #fbbf24" }}
                    />
                    <div className="text-[13px] leading-snug text-white/80">
                      <span className="font-semibold text-white">
                        The vote QR points at localhost,
                      </span>{" "}
                      so phones can&apos;t reach it. For an in-room audience, open the studio
                      via your LAN IP (e.g. http://192.168.x.x:3000/studio). For remote
                      viewers on Zoom/Meet, self-host or tunnel Capturia and set
                      NEXT_PUBLIC_CAPTURIA_ORIGIN to that public URL.
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Layer 3: command bar */}
          <CommandBar
            overlays={overlays.map((o) => ({ id: o.id, type: o.type }))}
            onClear={() => setOverlays([])}
            isListening={isListening}
            onToggleVoice={() => (isListening ? stopListening() : startListening())}
            isVoiceSupported={isSupported}
            // The studio's ONE agent driver, passed down so both input channels
            // share the same agent/thread and the same busy signal (a second
            // useAgentRun call site would get its own provisional agent while
            // the runtime handshake is pending, or forever if it failed).
            sendMessage={sendMessage}
            agentBusy={isRunning}
          />

          {/* Left rail: deck cue cards */}
          <CueDeck
            cards={cues}
            fileName={deckName}
            onTrigger={applyCue}
            onClear={() => {
              setCues([]);
              setDeckFacts(null);
              setDeckName(null);
            }}
          />

          {/* Top-right HUD: deck + output + settings + LIVE pill + clock + record */}
          <div className="absolute top-3 right-4 z-30 flex items-center gap-3">
            {/* Load a pitch deck (PDF), client-side */}
            <DeckDropzone
              provider={activeProvider}
              onLoaded={({ cards, facts, fileName }) => {
                setCues(cards);
                setDeckFacts(facts);
                setDeckName(fileName);
              }}
            />

            {/* Toggle A2UI Surface Mode: render overlays through the live A2UI
                runtime instead of the direct React renderer (Cmd+Shift+A) */}
            <button
              onClick={() => setSurfaceMode((v) => !v)}
              title="A2UI Surface Mode: render overlays via the live A2UI runtime (Cmd+Shift+A)"
              className={`text-[11px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-full border transition-all ${
                surfaceMode
                  ? "bg-cyan-500/20 text-cyan-200 border-cyan-400/40 shadow-[0_0_12px_rgba(34,211,238,0.25)]"
                  : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white border-white/10"
              }`}
            >
              A2UI
            </button>

            {/* Toggle audio-reactive FX (vignette + overlay breathing). Pin it
                off for an OBS scene with ?fx=0. */}
            <button
              onClick={() => setFxOn((v) => !v)}
              title="Audio-reactive FX: the feed breathes with your voice (?fx=0 to pin off)"
              className={`text-[11px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-full border transition-all ${
                fxOn
                  ? "bg-cyan-500/20 text-cyan-200 border-cyan-400/40 shadow-[0_0_12px_rgba(34,211,238,0.25)]"
                  : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white border-white/10"
              }`}
            >
              FX
            </button>

            {/* Toggle audience voting: a QR lands on the feed, phones vote at
                /vote/<room>, the tally moves live (?vote=1 to pin on). */}
            <button
              onClick={() => setVoteOn((v) => !v)}
              title="Audience voting: viewers scan the on-feed QR and vote from their phones (?vote=1 to pin on)"
              className={`text-[11px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-full border transition-all ${
                voteOn
                  ? "bg-cyan-500/20 text-cyan-200 border-cyan-400/40 shadow-[0_0_12px_rgba(34,211,238,0.25)]"
                  : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white border-white/10"
              }`}
            >
              Vote
            </button>

            {/* Enter clean Program Output (for OBS / virtual camera) */}
            <button
              onClick={() => setOutputMode(true)}
              title="Program Output for OBS / virtual camera (Cmd+Shift+O)"
              className="text-[11px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white border border-white/10 transition-all"
            >
              Output
            </button>

            {/* Settings (desktop only) */}
            {vault.isDesktop && (
              <button
                onClick={() => setSettingsOpen(true)}
                title="Settings (Cmd+,)"
                aria-label="Settings"
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 text-white/50 hover:bg-white/20 hover:text-white/90 border border-white/10 transition-all"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            )}

            {/* Record toggle */}
            <button
              onClick={() => (isRecording ? stopRecording() : startRecording())}
              className={`flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest px-3 py-1.5 rounded-full transition-all ${
                isRecording
                  ? "bg-red-600 text-white"
                  : "bg-white/10 text-white/50 hover:bg-white/20 hover:text-white/80 border border-white/10"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isRecording ? "bg-white live-dot-pulse" : "bg-red-500"
                }`}
              />
              {isRecording ? "Stop" : "Rec"}
            </button>

            {/* Live clock */}
            <div className="px-2.5 py-1 rounded-md bg-black/40 border border-white/10 backdrop-blur-md pointer-events-none">
              <HudClock />
            </div>

            {/* LIVE pill */}
            <div className="flex items-center gap-1.5 bg-red-600/95 px-2.5 py-1 rounded-md shadow-[0_0_12px_rgba(239,68,68,0.4)] pointer-events-none">
              <span className="w-1.5 h-1.5 rounded-full bg-white live-dot-pulse" />
              <span className="text-white text-[10px] font-bold tracking-[0.2em] uppercase">
                Live
              </span>
            </div>
          </div>

          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            keys={vault.keys}
            isReady={vault.isReady}
            save={vault.save}
            clear={vault.clear}
            activeProvider={activeProvider}
            onSelectProvider={setActiveProvider}
          />
        </>
      )}

      {/* Program Output: a single hover-revealed control to exit, so the
          captured feed stays clean but the operator can leave the mode. On a
          mirror receiver this NAVIGATES to the Control Room URL instead of
          flipping state (see exitProgramOutput). */}
      {outputMode && (
        <button
          onClick={exitProgramOutput}
          className="absolute top-3 right-3 z-30 text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-full bg-black/50 text-white/40 border border-white/10 opacity-0 hover:opacity-100 transition-opacity"
          title={
            isMirrorReceiver
              ? "Open this page as a Control Room (reloads without ?out=1)"
              : "Exit Program Output (Cmd+Shift+O)"
          }
        >
          Exit output
        </button>
      )}
    </div>
  );
}
