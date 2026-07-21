# Capturia

> **Broadcast-grade live video overlays composed by an AI agent, from voice or text, in under a second. The chat is the screen.**

Capturia is a live video overlay tool for talks, streams, and product demos. There is no chat sidebar, no template gallery, no graphics operator. You point your webcam at yourself, speak (or type), and an AI agent composes spatial UI components (lower-thirds, metrics panels, sparkline charts, big counters, ticker bands, keyword chips, donut rings, letterbox bars) directly onto the video feed in real time. The agent never replies in prose. Every utterance is either a tool call that changes the on-screen state, or silence.

Built solo for the **Generative UI Global Hackathon**, May 2026.

---

## Download

Capturia ships as a signed, notarized macOS app (latest release
v0.1.3). Grab it at <https://www.capturia.dev>: install once and
**Capturia** shows up as a camera in Zoom, Meet, and Slack. The free web
studio lives on the same site and needs no download at all.

---

## See it work

The agent has a typed catalog of 13 display components plus one interactive button. A few example interactions:

| You say (or type)… | What happens on screen |
| --- | --- |
| *"My name is Alex, founder of Acme"* | A `LowerThird` types in with a gradient brand bar and underline sweep |
| *"Our Q4 revenue is 1.8M up 24%, users 18K up 12%, churn 2.1%"* | A `MetricsPanel` materializes; sparklines start tracking each row |
| *"Bump revenue to 2.1M"* | Row count-ups, flashes green, sparkline appends a new point. The panel does **not** redraw |
| *"Add a chart with data 12 18 24 31 47"* | A `FloatingChart` appears with gradient bars or area-fill line |
| *"Append 62 to the chart"* | Polyline morphs to the new shape; last-point dot glows |
| *"Move the chart to the top right"* | Smooth FLIP-style transform between anchor positions |
| *"Add a big counter for twelve thousand viewers"* | Per-digit roll; crossing 10K bursts a milestone halo |
| *"Highlight keywords AI, growth, demo with auto color"* | Rainbow chips bob into the corner with a shimmer sweep |
| *"Add letterbox"* | Black cinematic bars slide in from the screen edges |
| *"Run a yes/no poll"* | The agent authors a surface with tappable `ActionButton`s plus a tally panel; votes bump the tally live |
| Click **Vote**, audience scans the on-feed QR | Phones vote at `/vote/<room>`; the tally mirrors the live counts with no per-vote model calls |
| *"Clear everything"* | All overlays exit gracefully with hand-tuned exit animations |

**Voice mode:** click the mic icon (Chrome or Edge, via the Web Speech API).
**Type mode:** the empty-state quick-action chips fire example commands in one click.

---

## Quick start

```bash
npm install
echo "GOOGLE_GENERATIVE_AI_API_KEY=your_key_here" > .env.local
npm run dev
```

Get a free Gemini API key at <https://aistudio.google.com>.

Open <http://localhost:3000> in **Chrome** or **Edge**. (Brave Shields blocks the Web Speech API endpoint; Firefox doesn't implement it. The studio shows a dismissable heads-up in those browsers; typed commands still work.)

Run the unit tests with `npm test` (vitest; covers the surface-tree sanitizer, prop coercion, JSON extraction, the energy envelope, and the server key guard).

To capture the demo as a video file, click **Rec** in the top-right HUD. It records the current tab via `getDisplayMedia` muxed with mic audio and downloads as `capturia-{ts}.webm`.

---

## Desktop wrapper (optional)

Capturia also runs as a native Electron app, with extras the web demo cannot offer:

- **Local STT via whisper.cpp** (audio never leaves your machine, works in any browser-equivalent environment)
- **Global push-to-talk hotkey** `Cmd+Alt+Space` (toggles voice mid-Zoom-call without alt-tabbing)
- **VAD auto-stop**: speak naturally, pause, transcription fires automatically
- **BYOK key vault** stored in the OS Keychain (macOS) / Credential Manager (Windows)

```bash
# One-time setup (~1 to 2 minutes)
brew install cmake             # if you don't have it (Linux: your package manager)
npx nodejs-whisper download    # pick base.en (142MB), decline CUDA

# Run
npm run electron-dev
```

Press `Cmd+,` to open Settings, paste your own API key (encrypted via OS Keychain), and pick which provider drives the agent. **The desktop agent now runs entirely on your key (BYOK)**: the renderer attaches it as a per-request header and the runtime builds the model per request, so Capturia incurs no LLM cost for you. The web demo still uses the project's env key. Prefer no key setup at all? **Capturia Pro** runs the agent on hosted keys; see [docs/hosted-tier.md](docs/hosted-tier.md).

**Show Capturia in a real call today.** The desktop app ships a native "Capturia" camera device: install the bundled macOS camera extension once (onboarding or the tray's "Install camera" item walks you through it) and **Capturia** appears directly in every call app's camera picker, no OBS in between. On the web studio, click **Output** (or `Cmd+Shift+O`) for a chrome-free Program Output feed and publish it through OBS Virtual Camera instead. Both paths are covered in [docs/virtual-camera.md](docs/virtual-camera.md).

**Drop your pitch deck.** Drag a PDF onto the studio (or click **Deck**). Capturia reads it on your device, primes the agent with your real titles and numbers, and builds a rail of cue cards you trigger by click or by voice.

**Surface Mode (A2UI).** Toggle the **A2UI** button (or `Cmd/Ctrl+Shift+A`, or open `/studio?surface=1`) to render the live overlays through the genuine A2UI runtime (the registered `capturiaCatalog` rendered by `<A2UIRenderer>` against the A2UI v0.9 protocol) instead of the direct React renderer. Same overlays, same look; it just proves the typed catalog is a real renderable surface, not only a schema. It composes with Program Output, so the A2UI-rendered feed is what OBS captures.

**Agent-authored surfaces.** Beyond placing the fixed catalog components, the agent can **author an A2UI tree itself** with the `render_surface` tool: a layout of branded Capturia overlays (stacked in a `Column`, sided in a `Row`) composed into one laid-out unit and rendered through the real A2UI v0.9 pipeline. Say *"build me a stat block"* and the model composes the surface rather than firing single placements. The authored tree is untrusted, so a sanitizer (`lib/a2ui-validate.ts`) whitelists components to transparent layout primitives + the Capturia catalog (no off-brand Material chrome), strips data-binding/action and prototype-pollution keys, and rejects cycles, dangling child refs, and oversized/over-deep trees before anything reaches the feed. These surfaces always render through the A2UI runtime (their own host), independent of the Surface Mode toggle.

**Interactive surfaces ([ACTION] loop).** Authored surfaces can include **`ActionButton`**, the one tappable catalog leaf. Say *"run a yes/no poll"* and the agent renders the question plus buttons; a tap is dispatched through the real A2UI action pipeline (`dispatch` → `A2UIProvider onAction`) and re-injected into the session as an `[ACTION] poll-yes` user turn, exactly like `[VOICE]` transcripts, so the agent answers by changing the scene (bumping a tally, revealing results, advancing steps). The loop is fully client-side: the agent never authors event bindings (the sanitizer still rejects `path`/`call`/`event` keys; the dispatch envelope is built at click time in the catalog renderer), so it ships today on Gemini 2.5 with no `thought_signature` roundtrip. While a turn is running, buttons dim and disable via pure CSS so a mid-run tap reads as "thinking", never broken.

**Audio-reactive feed.** While voice is live, the whole frame breathes with the speaker: a cyan vignette and select overlays (BigCounter scale, LiveBadge glow) track a 0..1 "speaking energy" published as a `--mic-energy` CSS variable. There is **no AudioContext** involved (it cannot coexist with the Web Speech API); the energy is derived from speech-recognition result events with a time-based attack/decay envelope (`lib/energy.ts`), so 60Hz and 120Hz displays breathe identically and the per-frame work stays on the compositor. The **FX** HUD pill (or `?fx=0`) pins a static frame when the cyan accent clashes with your branding.

**Audience voting.** Click the **Vote** HUD pill (or `?vote=1`) and a QR code lands on the published feed itself, so the people watching your fake camera in Zoom/Meet (or sitting in the room) can scan it and vote from their phones at `/vote/<room>`. The current poll is derived live from the authored surface's `ActionButton`s; phone votes hit an in-memory room on the same Next server (one switchable vote per viewer, rate-limited, host-key auth on the poll, SSE back out) and the on-feed tally mirrors the server's counts **deterministically**, no agent turn per vote, so a room of phones can't melt the one-turn-at-a-time agent loop. While voting is on, the operator's own taps count as votes through the same room, keeping one source of truth. Reachability is physics: phones must reach your server, so for in-room audiences open the studio via your LAN IP (the QR follows the URL you used), and for remote Zoom/Meet viewers self-host or tunnel Capturia and set `NEXT_PUBLIC_CAPTURIA_ORIGIN` to the public URL; the studio shows an operator-only warning when the QR would point at localhost. The packaged desktop app runs from `file://`, so `npm run build:electron` bakes `NEXT_PUBLIC_CAPTURIA_ORIGIN=https://www.capturia.dev` into the export: its vote rooms live on the hosted deploy, the QR points there, and the studio's own room traffic travels there too (set the variable yourself at build time to aim a self-built bundle at your own deploy instead). The vote room is in-memory and single-process by default, which is perfect for the operator's own machine and self-hosts but does not survive serverless invocations. For a hosted deploy (Vercel), enable the Upstash Redis integration on the project: as soon as its env vars exist (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, or the `KV_REST_API_*` flavor), rooms move to Redis with identical semantics (atomic Lua, same auth/rate limits/caps) and live updates arrive over a short-lived SSE polling bridge. Certify a deploy any time with `CAPTURIA_BASE_URL=https://your-deploy node scripts/verify-vote-redis.mjs` (14 contract checks). The free local path never needs the paid dependency.

---

## Stack

| Layer | Tech |
| --- | --- |
| Framework | Next.js 16.2.6 (App Router, Turbopack) |
| UI | React 19.2.4, Tailwind CSS v4, raw CSS keyframes |
| Agent runtime | CopilotKit 1.57.1 (`@copilotkit/runtime/v2`, single-route mode) |
| Catalog | `@copilotkit/a2ui-renderer` (real `createCatalog` against Zod schemas) |
| Model | Gemini 2.5 Flash-Lite via `@ai-sdk/google` (`maxSteps: 1`, `temperature: 0`) |
| Voice | Web Speech API (browser-native) |
| Recording | MediaRecorder + getDisplayMedia (VP9+Opus webm) |
| Schemas | Zod |
| Hosting | Vercel |

---

## How it works

The agent doesn't manipulate the DOM. It sees a typed catalog of components and decides what to render where, with what props, by calling tools.

**Frontend** (`app/studio/page.tsx`) registers eight tools the agent can call via `useFrontendTool` from the `@copilotkit/react-core/v2` client (Zod parameter schemas, `followUp: false` so one command stays one model call). `useAgentContext` shares the current overlay list back into the agent's context as **AG-UI shared state** (including each authored surface's live `ActionButton`s), so the agent always knows what's on screen and can target updates by `id`. A shared `hooks/useAgentRun.ts` (`useAgent` + the core's `runAgent`, called once and passed down to CommandBar) sends every user turn on the same thread: typed commands, voice transcripts as `[VOICE]`-prefixed messages, and `ActionButton` taps as `[ACTION]`-prefixed ones. The v1 client hooks (`useCopilotAction`, `useCopilotReadable`, `useCopilotChat().appendMessage`) are gone: their send path never reached the v2 runtime's tool loop, which is exactly the bug documented in [docs/known-issues.md](docs/known-issues.md).

**Backend** (`app/api/copilotkit/[[...slug]]/route.ts`) wraps `BuiltInAgent` from `@copilotkit/runtime/v2`. Single-route mode, in-memory thread state, `maxSteps: 1` so each utterance is one model call (no internal roundtrip), `temperature: 0` for deterministic tool selection. ~150 ms TTFT on Gemini 2.5 Flash-Lite.

**A2UI catalog** (`lib/a2ui-catalog.tsx`) uses real `createCatalog` from `@copilotkit/a2ui-renderer` to register each Zod-defined component with its React adapter renderer. The Zod schemas in `lib/catalog.ts` are the single source of truth: they define the prop shape the agent must produce *and* are imported by the renderers themselves. The catalog object is exposed at `window.capturiaCatalog` for live inspection and powers **Surface Mode** (`Cmd/Ctrl+Shift+A`), which renders the same overlays through the genuine `<A2UIRenderer>` + A2UI v0.9 pipeline instead of the direct React renderer.

**Latency budget** for a single voice utterance:

1. Web Speech `onresult` fires (interim → final transcript)
2. `useAgentRun` adds the transcript to the AG-UI thread as a `[VOICE]` user message and runs the agent
3. Gemini 2.5 Flash-Lite emits an `add_overlay` tool call (~150 ms TTFT)
4. CopilotKit dispatches the call to the registered `useFrontendTool` handler for `add_overlay`
5. `setOverlays(prev => [...prev, { id, type, position, props }])` mutates React state
6. `OverlayLayer` reconciles with a 60ms-staggered entrance per new item
7. The overlay's hand-authored CSS keyframe plays (`overlay-enter`, `digit-roll`, `letterbox-enter-top`, etc.)

Subsequent updates use the same loop but trigger different visual responses. `bump_metric` count-up tweens a row, `append_chart_data` morphs a polyline, `move_overlay` triggers a FLIP transform, `BigCounter` rolls each digit independently and bursts a milestone halo.

---

## Component catalog

13 spatial overlays plus `ActionButton`, the one interactive leaf (surface-only: it can appear inside `render_surface` trees, never as a standalone overlay). The agent picks based on context and prompt rules.

| Component | Purpose | Notable animation |
| --- | --- | --- |
| `LowerThird` | Broadcast name + role bar | Letter-reveal typewriter, gradient bar, underline sweep on completion |
| `MetricsPanel` | KPI card with 2-4 rows | Per-row sparkline, count-up tween, green/red row flash, ▲/▼ delta arrows |
| `BigCounter` | Huge animated number | Per-digit roll on each changing digit, gradient text fill, milestone halo at 1K/10K/100K/1M |
| `StatRing` | Radial donut % | SVG `linearGradient` stroke (cyan → violet → pink), 5 sparkle dots when ≥85%, center % pop on each new target |
| `ProgressBar` | Linear progress | Cycling-hue gradient fill, glowing leading bead, % chip turns emerald + pulses at 100% |
| `FloatingChart` | Sparkline or bars | Gradient bars or line + area fill, last-point glowing dot, current-value display |
| `Timeline` | Horizontal stepper | Gradient active dot + halo ripple, gradient connector fills as steps complete |
| `KeywordHighlight` | Glowing keyword chips | Rotating palette when `color="auto"`, idle bob per chip, shimmer sweep |
| `ChatBubble` | Speech bubble | Gradient avatar circle with author initial, 3-dot typing indicator, typewriter reveal |
| `Letterbox` | Cinematic black bars | Slides in/out from screen edges (not fade) |
| `Ticker` | Cable-news scrolling band | Alternating accent dots per item, breathing color sheen |
| `CountdownTimer` | Big on-feed countdown clock | Ticks client-side (no agent turns), walks green → amber → red, counts overtime upward past zero |
| `LiveBadge` | Pulsing "LIVE" pill | Ring ripple radiating outward + dot pulse, brightens with speaking energy |
| `ActionButton` | Tappable pill inside authored surfaces | Glow ring; tap fires an `[ACTION] <name>` turn back to the agent; dims while a turn runs |

---

## The eight tools

The agent calls one of eight typed tools. Never freeform DOM mutations.

| Tool | Purpose |
| --- | --- |
| `add_overlay(id, type, position, props)` | Register a new overlay |
| `compose_scene(elements, replace?)` | Lay out a whole multi-element scene in one call (push a whole UI at once) |
| `render_surface(id, position, components)` | Author an A2UI component tree: branded overlays composed inside layout primitives, rendered through the live A2UI runtime |
| `modify_overlay(id, props)` | Wholesale prop replacement (rare; the agent prefers the incremental ones) |
| `remove_overlay(id)` | Remove one overlay or `"all"` |
| `move_overlay(id, position)` | Smooth FLIP transition between anchors |
| `append_chart_data(id, values)` | Grow a `FloatingChart` over time |
| `bump_metric(id, label, value, delta)` | Update one row in a `MetricsPanel` with count-up + flash |

The system prompt nudges the agent toward incremental tools (`bump_metric`, `append_chart_data`, `move_overlay`) over full replacements. That's where the "live" feel comes from: values count up, points slide in, panels move instead of being rebuilt. For "set up my intro" / "reset and show the results" moments, `compose_scene` lets the agent place several independently anchored components at once (with optional `replace` to clear the stage first) rather than firing a burst of single `add_overlay` calls. `compose_scene` and `add_overlay` place fixed leaf overlays; `render_surface` is the step up: the model **authors the A2UI tree itself** — a layout of branded Capturia overlays grouped into one laid-out unit, rendered through the genuine A2UI v0.9 runtime (see "Agent-authored surfaces" below).

---

## Engineering notes

A few decisions worth calling out for anyone reading the code:

**Defensive runtime layer.** Agent-emitted JSON is untrusted. Gemini occasionally returns `keywords: [{text: "x"}]` instead of `string[]`, or `metrics` rows with numeric `value`s. A shared `normalizeProps(type, props)` helper applied to **both** `add_overlay` and `modify_overlay` coerces malformed shapes (`metrics`, `keywords`, chart `data`, `steps`, `items`, `currentStep`) into safe ones. Each component also guards its own iteration with `Array.isArray(...)` filters so partial props can't crash the tree.

**Voice mode quirks.** Web Speech API and `AudioContext` cannot run simultaneously. Running both makes the speech service enter a rapid restart loop, which is why the audio-reactive energy layer never opens an analyser at all: it derives speaking energy from Web Speech's own `onresult` timestamps (`hooks/useSpeechEnergy.ts`), eased by a pure, time-based envelope (`lib/energy.ts`) into a `--mic-energy` CSS variable that overlays read with zero React state in the hot path. The `onend` handler restarts recognition with a 600 ms delay (no delay = same loop). A persistent `lastError` state survives the cycling so users actually see what went wrong.

**Animation system, not Tailwind plugin.** Tailwind v4 silently drops `animate-in` / `fade-in` / `slide-in-*` utility classes (the old `tailwindcss-animate` plugin isn't bundled in v4). All ~20 keyframes live hand-authored in `app/globals.css`: `digit-roll`, `ring-ripple`, `idle-bob`, `sparkle`, `particle-drift`, `hue-cycle`, `underline-sweep`, `milestone-burst`, `delta-flash-up/down`, `letterbox-enter-top/bottom`, `border-breathe`, `live-dot-pulse`, `ticker-scroll`, `shimmer-sweep`, `stripe-march`, `step-pop`, `progress-pulse`, `arrow-bounce-up/down`, `typing-dot`, `voice-bar`, `mic-glow`.

**FLIP transitions.** When `move_overlay` changes an overlay's anchor class, the inner wrapper measures `getBoundingClientRect()` before and after, then animates the delta as a transient `transform: translate(...)`. The outer Tailwind transforms (e.g., `-translate-x-1/2`) are preserved on the parent, so the slide composes cleanly with anchor centering.

**A2UI catalog drives two render paths.** `lib/a2ui-catalog.tsx` invokes `createCatalog` (catalogId `capturia`) and exposes the result on `window.capturiaCatalog`. The default hot path flows through CopilotKit AG-UI tool calls into the direct React renderer (`OverlayLayer`), the fastest and simplest path for per-component live updates. **Surface Mode** (opt-in via `?surface=1`, `Cmd/Ctrl+Shift+A`, or the **A2UI** HUD button) renders the *same* overlays state through the genuine A2UI runtime: each overlay becomes its own A2UI v0.9 surface (`createSurface` + `updateComponents`, root id `"root"`), fed to a self-managed `A2UIProvider` and rendered by `<A2UIRenderer surfaceId=…/>` against the registered catalog. `lib/a2ui-scene.ts` does the `OverlaySpec → A2UI message` translation; `components/A2uiOverlayLayer.tsx` (loaded via `next/dynamic` `ssr:false`, since the renderer is client-only) reuses `OverlayLayer`'s positioning/enter-exit/FLIP machinery so both modes look identical. One source of truth (`overlays`), two renderers, so the AG-UI tools, deck cue matching, and `compose_scene` drive both unchanged.

**Why Gemini 2.5 Flash-Lite, not 3.x.** Gemini 3.x stamps tool calls with a `thought_signature` that must be echoed back on subsequent turns. CopilotKit's AG-UI roundtrip doesn't propagate it yet, so tool-using flows on 3.x error after the second tool call. Disabling thinking (`thinkingBudget: 0`) is allowlist-gated on 3.x, so we can't flip our way out. 2.5 Flash-Lite has thinking off by default and works cleanly. The proper fix is a custom-agent factory that captures and replays signatures (~1 to 2 hours of work, planned for after the demo).

---

## Project layout

```
app/
  api/copilotkit/[[...slug]]/route.ts   ← CopilotKit v2 backend, BuiltInAgent + Gemini
  api/vote/[room]/route.ts              ← audience voting: snapshot, SSE stream, vote/publish POST
  globals.css                           ← all keyframes live here
  layout.tsx                            ← root layout, fonts, metadata
  page.tsx                              ← landing page ("On Air")
  studio/page.tsx                       ← Capturia studio: eight useFrontendTool handlers, leaf + surface render layers
  vote/[room]/page.tsx                  ← the phone page behind the on-feed vote QR
components/
  A2uiOverlay.tsx                       ← A2UI host: Surface Mode leaf + authored-surface tree
  A2uiOverlayLayer.tsx                  ← A2UIProvider mount (Surface Mode + authored surfaces, [ACTION] loop)
  AmbientParticles.tsx                  ← floating particle layer when voice is live
  BrowserBanner.tsx                     ← dismissable heads-up when the browser can't do voice
  CommandBar.tsx                        ← input + voice toggle + empty-state quick chips
  HudClock.tsx                          ← top-right live clock
  LiveCaptions.tsx                      ← interim transcript + speech status + last error
  ModelKeyBanner.tsx                    ← operator error when the server has no model key
  OverlayLayer.tsx                      ← overlay reconciliation, FLIP transitions, exit tracking
  WebcamFeed.tsx                        ← getUserMedia → fullscreen video
  overlays/                             ← 13 reactive components + ActionButton (interactive leaf)
hooks/
  useAgentRun.ts                        ← the one v2 agent driver: send + busy + run-error state
  useNumberTween.ts                     ← rAF-based number + array tween + parseNumeric helpers
  useRecorder.ts                        ← getDisplayMedia + getUserMedia → webm download
  useSpeechEnergy.ts                    ← speech-result energy → --mic-energy CSS var (no AudioContext)
  useTypewriter.ts                      ← per-character text reveal
  useVoiceCapture.ts                    ← Web Speech API wrapper with status + persistent error
lib/
  a2ui-catalog.tsx                      ← real createCatalog registration (client-only, includeBasicCatalog)
  a2ui-scene.ts                         ← OverlaySpec → A2UI v0.9 message translation (leaf + surface)
  a2ui-validate.ts                      ← sanitizer for agent-authored surface trees (tested)
  catalog.ts                            ← Zod schemas for the catalog + placement boundary (tested)
  derive-poll.ts                        ← authored surface → audience poll mapping (tested)
  energy.ts                             ← pure time-based attack/decay envelope (tested)
  extract-json.ts                       ← fence/prose-tolerant JSON array recovery (tested)
  limits.ts                             ← tool-arg size cap (tested)
  normalize.ts                          ← untrusted-prop coercion, agent + deck (tested)
  positions.ts                          ← anchor → Tailwind class map
  server-keys.ts                        ← model spec + API-key resolution for the route guard (tested)
  system-prompt.ts                      ← agent identity, voice/action rules, catalog hints
  types.ts                              ← OverlaySpec union (+ Surface variant, A2uiNode)
  vote-store.ts                         ← in-memory audience-vote rooms: auth, dedupe, rate limit, SSE fanout (tested)
  deck/                                 ← PDF extract, cue building, LLM codegen, validate (tested)
```

---

## Roadmap

**Shipped:** Desktop BYOK key vault, deck-aware cue cards, Program Output / OBS virtual-camera path, **Surface-mode A2UI rendering** (the registered catalog renders live through `<A2UIRenderer>`; `compose_scene` pushes a whole UI at once), **agent-authored A2UI surfaces** (`render_surface`: the model composes its own A2UI tree of branded overlays inside layout primitives, sanitized via `lib/a2ui-validate.ts` and rendered through the real A2UI v0.9 runtime), **interactive surfaces** (`ActionButton` taps loop back as `[ACTION]` turns, fully client-side, live on Gemini 2.5 today), the **audio-reactive feed** (speech-derived `--mic-energy`, no AudioContext), **audience voting** (on-feed QR, phones vote at `/vote/<room>`, deterministic live tally), the **native "Capturia" camera** (macOS camera extension, no OBS; installed by the app itself), the **desktop DMG** (Developer ID signed, notarized, stapled; latest release v0.1.3 at [capturia.dev](https://www.capturia.dev), runbook in [docs/release.md](docs/release.md)), the **consent-gated telemetry beacon** (four anonymous fields, nothing before the onboarding choice; [docs/telemetry.md](docs/telemetry.md)), and the **Capturia Pro hosted tier** (Stripe billing, activation codes, hosted-key LLM proxy; [docs/hosted-tier.md](docs/hosted-tier.md)).

Next:

- **Face / body tracking**: overlays that follow the speaker (MediaPipe)
- **Real-time data feeds**: `MetricsPanel` connected to live revenue / analytics endpoints
- **Richer interactive components**: inputs and selectors on authored surfaces; the client-side `[ACTION]` loop shipped, and the server-side `@ag-ui/a2ui-middleware` / `log_a2ui_event` path (with a data model) pairs with the Gemini 3.x factory below
- **Extension catalog**: third-party overlay registrations (sponsor cards, poll widgets, branded components)
- **Speech fallback**: Deepgram or Groq Whisper for Brave / Firefox / mobile
- **Multi-language voice prompt**: currently English-only
- **Custom-agent factory for Gemini 3.x** with `thought_signature` replay so we can move to the faster model
- **MCP integration** for sourcing live data feeds

---

## Docs

- [docs/virtual-camera.md](docs/virtual-camera.md): both camera paths, the native extension and the OBS bridge
- [docs/hosted-tier.md](docs/hosted-tier.md): the Capturia Pro hosted tier (billing, entitlements, LLM proxy)
- [docs/release.md](docs/release.md): the DMG release runbook (signing, notarization, stapling)
- [docs/telemetry.md](docs/telemetry.md): the consent-gated four-field beacon, and every way to turn it off
- [docs/known-issues.md](docs/known-issues.md): the v1-vs-v2 CopilotKit client history and model quirks
- [docs/e2e-checklist.md](docs/e2e-checklist.md): the manual passes that need real hardware or human judgment

---

## Contribute

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and architecture notes.

Some easy first contributions:

1. **Add a new overlay component.** Define the Zod schema in `lib/catalog.ts`, build the React component in `components/overlays/`, register the renderer in `lib/a2ui-catalog.tsx`. Match the broadcast-subtle animation language (entrance under 400ms, ease-out cubic, white/10 borders, backdrop blur).
2. **VAD streaming + interim transcripts** for the desktop Whisper path so it feels continuous like Web Speech.
3. **Localize the agent prompt** in `lib/system-prompt.ts` for non-English voice input.
4. **Wire a real data source** into `MetricsPanel` or `BigCounter` (Stripe, PostHog, Twitch viewer count, anything live).

For security issues, see [SECURITY.md](SECURITY.md) instead of public issues.

## License

MIT. See [LICENSE](LICENSE).

Capturia is open source under MIT. The commercial tier, **Capturia Pro** (the agent on hosted keys, no BYOK setup; see [docs/hosted-tier.md](docs/hosted-tier.md)), runs alongside it and its server code lives in this same repo. The core app stays free and open.

---

## Built for

The **Generative UI Global Hackathon**, May 2026. Solo build by Andres Carreon, founder of Bubblio.

