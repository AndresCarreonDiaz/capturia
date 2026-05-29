# Capturia

> **Broadcast-grade live video overlays composed by an AI agent, from voice or text, in under a second. The chat is the screen.**

Capturia is a live video overlay tool for talks, streams, and product demos. There is no chat sidebar, no template gallery, no graphics operator. You point your webcam at yourself, speak (or type), and an AI agent composes spatial UI components (lower-thirds, metrics panels, sparkline charts, big counters, ticker bands, keyword chips, donut rings, letterbox bars) directly onto the video feed in real time. The agent never replies in prose. Every utterance is either a tool call that changes the on-screen state, or silence.

Built solo for the **Generative UI Global Hackathon**, May 2026.

---

## See it work

The agent has 12 components in a typed catalog. A few example interactions:

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

Open <http://localhost:3000> in **Chrome** or **Edge**. (Brave Shields blocks the Web Speech API endpoint; Firefox doesn't implement it. Voice will fail in those browsers; typed commands still work.)

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

Press `Cmd+,` to open Settings, paste your own API key (encrypted via OS Keychain), and pick which provider drives the agent. **The desktop agent now runs entirely on your key (BYOK)**: the renderer attaches it as a per-request header and the runtime builds the model per request, so Capturia incurs no LLM cost for you. The web demo still uses the project's env key.

**Show Capturia in a real call today.** Click **Output** (or `Cmd+Shift+O`) for a chrome-free Program Output feed, then publish it through OBS Virtual Camera and pick it in Zoom, Teams, or Meet. See [docs/virtual-camera.md](docs/virtual-camera.md). A native "Capturia" camera device (no OBS) is the next step and needs the macOS Camera Extension entitlement (Apple Developer account).

**Drop your pitch deck.** Drag a PDF onto the studio (or click **Deck**). Capturia reads it on your device, primes the agent with your real titles and numbers, and builds a rail of cue cards you trigger by click or by voice.

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

**Frontend** (`app/page.tsx`) registers six tools the agent can call via `useCopilotAction`. `useCopilotReadable` shares the current overlay list back into the agent's context as **AG-UI shared state**, so the agent always knows what's on screen and can target updates by `id`. `useCopilotChat().appendMessage` pipes voice transcripts into the same session as `[VOICE]`-prefixed messages.

**Backend** (`app/api/copilotkit/[[...slug]]/route.ts`) wraps `BuiltInAgent` from `@copilotkit/runtime/v2`. Single-route mode, in-memory thread state, `maxSteps: 1` so each utterance is one model call (no internal roundtrip), `temperature: 0` for deterministic tool selection. ~150 ms TTFT on Gemini 2.5 Flash-Lite.

**A2UI catalog** (`lib/a2ui-catalog.tsx`) uses real `createCatalog` from `@copilotkit/a2ui-renderer` to register each Zod-defined component with its React adapter renderer. The Zod schemas in `lib/catalog.ts` are the single source of truth: they define the prop shape the agent must produce *and* are imported by the renderers themselves. The catalog object is exposed at `window.capturiaCatalog` for live inspection and is the foundation for the upcoming `<A2UIRenderer>` surface mode.

**Latency budget** for a single voice utterance:

1. Web Speech `onresult` fires (interim → final transcript)
2. Transcript appended to the AG-UI session as a `[VOICE]` user message
3. Gemini 2.5 Flash-Lite emits an `add_overlay` tool call (~150 ms TTFT)
4. CopilotKit dispatches the call to `useCopilotAction("add_overlay")`
5. `setOverlays(prev => [...prev, { id, type, position, props }])` mutates React state
6. `OverlayLayer` reconciles with a 60ms-staggered entrance per new item
7. The overlay's hand-authored CSS keyframe plays (`overlay-enter`, `digit-roll`, `letterbox-enter-top`, etc.)

Subsequent updates use the same loop but trigger different visual responses. `bump_metric` count-up tweens a row, `append_chart_data` morphs a polyline, `move_overlay` triggers a FLIP transform, `BigCounter` rolls each digit independently and bursts a milestone halo.

---

## Component catalog

12 spatial overlays. The agent picks based on context and prompt rules.

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
| `LiveBadge` | Pulsing "LIVE" pill | Ring ripple radiating outward + dot pulse |

---

## The six tools

The agent calls one of six typed tools. Never freeform DOM mutations.

| Tool | Purpose |
| --- | --- |
| `add_overlay(id, type, position, props)` | Register a new overlay |
| `modify_overlay(id, props)` | Wholesale prop replacement (rare; the agent prefers the incremental ones) |
| `remove_overlay(id)` | Remove one overlay or `"all"` |
| `move_overlay(id, position)` | Smooth FLIP transition between anchors |
| `append_chart_data(id, values)` | Grow a `FloatingChart` over time |
| `bump_metric(id, label, value, delta)` | Update one row in a `MetricsPanel` with count-up + flash |

The system prompt nudges the agent toward incremental tools (`bump_metric`, `append_chart_data`, `move_overlay`) over full replacements. That's where the "live" feel comes from: values count up, points slide in, panels move instead of being rebuilt.

---

## Engineering notes

A few decisions worth calling out for anyone reading the code:

**Defensive runtime layer.** Agent-emitted JSON is untrusted. Gemini occasionally returns `keywords: [{text: "x"}]` instead of `string[]`, or `metrics` rows with numeric `value`s. A shared `normalizeProps(type, props)` helper applied to **both** `add_overlay` and `modify_overlay` coerces malformed shapes (`metrics`, `keywords`, chart `data`, `steps`, `items`, `currentStep`) into safe ones. Each component also guards its own iteration with `Array.isArray(...)` filters so partial props can't crash the tree.

**Voice mode quirks.** Web Speech API and `AudioContext` cannot run simultaneously. Running both makes the speech service enter a rapid restart loop. The mic-level visualizer is gated to `isListening === false`. The `onend` handler restarts recognition with a 600 ms delay (no delay = same loop). A persistent `lastError` state survives the cycling so users actually see what went wrong.

**Animation system, not Tailwind plugin.** Tailwind v4 silently drops `animate-in` / `fade-in` / `slide-in-*` utility classes (the old `tailwindcss-animate` plugin isn't bundled in v4). All ~20 keyframes live hand-authored in `app/globals.css`: `digit-roll`, `ring-ripple`, `idle-bob`, `sparkle`, `particle-drift`, `hue-cycle`, `underline-sweep`, `milestone-burst`, `delta-flash-up/down`, `letterbox-enter-top/bottom`, `border-breathe`, `live-dot-pulse`, `ticker-scroll`, `shimmer-sweep`, `stripe-march`, `step-pop`, `progress-pulse`, `arrow-bounce-up/down`, `typing-dot`, `voice-bar`, `mic-glow`.

**FLIP transitions.** When `move_overlay` changes an overlay's anchor class, the inner wrapper measures `getBoundingClientRect()` before and after, then animates the delta as a transient `transform: translate(...)`. The outer Tailwind transforms (e.g., `-translate-x-1/2`) are preserved on the parent, so the slide composes cleanly with anchor centering.

**A2UI catalog is registered, not yet runtime-rendered.** `lib/a2ui-catalog.tsx` invokes `createCatalog` and exposes the result on `window.capturiaCatalog`. The catalog is the typed contract between the system prompt and the renderers, but the runtime hot path still flows through CopilotKit AG-UI tool calls (faster and simpler for per-component updates). Surface-mode rendering (`<A2UIRenderer surfaceId=…/>`) is the next milestone, which would let the agent push whole UIs at once.

**Why Gemini 2.5 Flash-Lite, not 3.x.** Gemini 3.x stamps tool calls with a `thought_signature` that must be echoed back on subsequent turns. CopilotKit's AG-UI roundtrip doesn't propagate it yet, so tool-using flows on 3.x error after the second tool call. Disabling thinking (`thinkingBudget: 0`) is allowlist-gated on 3.x, so we can't flip our way out. 2.5 Flash-Lite has thinking off by default and works cleanly. The proper fix is a custom-agent factory that captures and replays signatures (~1 to 2 hours of work, planned for after the demo).

---

## Project layout

```
app/
  api/copilotkit/[[...slug]]/route.ts   ← CopilotKit v2 backend, BuiltInAgent + Gemini
  globals.css                           ← all keyframes live here
  layout.tsx                            ← root layout, fonts, metadata
  page.tsx                              ← Capturia component, six useCopilotAction handlers, normalizeProps
components/
  AmbientParticles.tsx                  ← floating particle layer when voice is live
  CommandBar.tsx                        ← input + voice toggle + empty-state quick chips
  HudClock.tsx                          ← top-right live clock
  LiveCaptions.tsx                      ← interim transcript + speech status + last error
  OverlayLayer.tsx                      ← overlay reconciliation, FLIP transitions, exit tracking
  WebcamFeed.tsx                        ← getUserMedia → fullscreen video
  overlays/                             ← 12 reactive components
hooks/
  useMicLevel.ts                        ← AnalyserNode-based mic energy bars (off while voice is live)
  useNumberTween.ts                     ← rAF-based number + array tween + parseNumeric helpers
  useRecorder.ts                        ← getDisplayMedia + getUserMedia → webm download
  useTypewriter.ts                      ← per-character text reveal
  useVoiceCapture.ts                    ← Web Speech API wrapper with status + persistent error
lib/
  a2ui-catalog.tsx                      ← real createCatalog registration (client-only)
  catalog.ts                            ← Zod schemas for all 12 components
  positions.ts                          ← anchor → Tailwind class map
  system-prompt.ts                      ← agent identity, voice rules, catalog hints
  types.ts                              ← OverlaySpec discriminated union
```

---

## Roadmap

- **Face / body tracking**: overlays that follow the speaker (MediaPipe)
- **Real-time data feeds**: `MetricsPanel` connected to live revenue / analytics endpoints
- **Surface-mode A2UI rendering**: agent pushes whole UIs at once via `<A2UIRenderer>`
- **Extension catalog**: third-party overlay registrations (sponsor cards, poll widgets, branded components)
- **Speech fallback**: Deepgram or Groq Whisper for Brave / Firefox / mobile
- **Multi-language voice prompt**: currently English-only
- **Custom-agent factory for Gemini 3.x** with `thought_signature` replay so we can move to the faster model
- **MCP integration** for sourcing live data feeds

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

Capturia is open source under MIT. A separate commercial tier (cloud deck sync, team library, branded overlays, hosted codegen with caching) may be offered in the future as part of the Capturia commercial product. The core app in this repo stays free and open.

---

## Built for

The **Generative UI Global Hackathon**, May 2026. Solo build by Andres Carreon, founder of Bubblio.

