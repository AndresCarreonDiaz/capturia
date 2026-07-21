# Contributing to Capturia

Thanks for your interest. Capturia is a live video overlay tool where an AI agent composes spatial UI directly onto a webcam feed. PRs, ideas, and bug reports are all welcome.

## Quick setup

```bash
git clone https://github.com/AndresCarreonDiaz/capturia.git
cd capturia
npm install
cp .env.example .env.local
# Add your Google AI Studio key to .env.local
npm run dev
```

Open http://localhost:3000/studio in Chrome or Edge.

### Desktop wrapper (Electron)

```bash
# One-time: download whisper model + build whisper.cpp
# Requires cmake. Install via: brew install cmake
npx nodejs-whisper download
# Pick base.en (142MB), decline CUDA

# Run dev + Electron together
npm run electron-dev
```

This opens Capturia in a native window with local Whisper STT and the global hotkey `Cmd+Alt+Space`.

## Code style

- TypeScript strict mode. Run `npx tsc --noEmit` before pushing.
- Run `npm run lint` and address anything NEW. A pre-existing React 19 baseline (currently 19 errors + 1 warning) is known and documented; do not try to fix it in an unrelated PR, and do not add to it.
- Follow existing patterns: hand-authored CSS keyframes in `app/globals.css`, Tailwind v4 for layout, Zod schemas for the catalog.
- No em-dashes in user-facing copy (project preference). Use commas, periods, or restructure.

## Architecture in 30 seconds

- **Agent never replies in prose.** Every utterance is a tool call or silence. System prompt enforces this.
- **13 typed components** in `lib/catalog.ts`. Add new ones by adding a Zod schema, a React component in `components/overlays/`, and registering in `lib/a2ui-catalog.tsx`.
- **Backend** at `app/api/copilotkit/[[...slug]]/route.ts` runs CopilotKit v2 + `BuiltInAgent` with Gemini 2.5 Flash-Lite.
- **Desktop wrapper** is Electron. `electron/main.js` opens the studio in a native window. Local Whisper STT via IPC. BYOK key vault via OS Keychain.

See [README.md](README.md) for the full architecture.

## PR checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes
- [ ] `npm run lint` introduces no NEW problems beyond the documented React 19 baseline (currently 19 errors + 1 warning)
- [ ] `npx playwright test` passes for UI-affecting changes (it boots its own dev server; the live-agent test skips itself without a Gemini key)
- [ ] README updated if you added user-visible behavior
- [ ] Brief description of what changed and why

## Easy first contributions

1. **Add a new overlay component.** Zod schema in `lib/catalog.ts`, React component in `components/overlays/`, register in `lib/a2ui-catalog.tsx`. Match the broadcast-subtle animation language (entrance under 400ms, ease-out cubic, white/10 borders, backdrop blur).
2. **Speech recognition improvements.** Add VAD streaming for desktop, or a hosted-STT path for browsers without Web Speech.
3. **Localize the agent prompt** in `lib/system-prompt.ts` for non-English input.
4. **Wire a real data source** into MetricsPanel or BigCounter (Stripe, PostHog, Twitch viewer count).

## Reporting bugs

Use GitHub Issues with the bug template. Include reproduction steps and your OS/browser.

For security issues see [SECURITY.md](SECURITY.md).

## Code of conduct

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
