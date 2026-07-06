# Manual E2E checklist

`npm run test:e2e` covers the vote flow, the studio smoke paths, and (when a
Google key is present) one live agent turn. The paths below need real hardware
or human judgment; run them before a release-worthy merge.

## Voice loop (web, Chrome or Edge)

1. `npm run dev`, open `http://localhost:3000/studio` in Chrome (not Brave or
   Firefox; the voice button hides there by design).
2. Enable voice (mic button or the hotkey hint), allow the mic prompt.
3. Speak: "add a lower third with the name Andres Carreon". Expect the overlay
   within ~2s, live captions while speaking, and the audio-reactive vignette
   breathing with your voice (FX pill on).
4. Say "remove everything". Stage clears with exit animations.

## Poll + QR + real phone (the M5 wedge)

1. Set `NEXT_PUBLIC_CAPTURIA_ORIGIN` to `http://<your-LAN-IP>:3000` in
   `.env.local`, restart dev; phone and laptop on the same WiFi.
2. In the studio, type or say: "create a poll asking which topic next:
   APIs or Pricing". Expect an authored surface with two ActionButtons.
3. Turn voting on. Expect the QR badge on the FEED (it must survive `?out=1`)
   and no localhost warning.
4. Scan the QR with a real phone. Vote. Expect the on-feed tally
   (MetricsPanel `poll-tally`) to mirror the vote within ~1s without an agent
   turn.
5. Tap an ActionButton in the studio while voting is on. Expect it to count as
   a server vote (tally moves), not a duplicate agent action.
6. Switch your vote on the phone. Expect the tally to move, not double-count.

## Program Output into a real call (interim OBS path)

1. `Cmd+Shift+O` (or `?out=1`) for the chrome-free output window.
2. OBS: window capture of that window, Start Virtual Camera.
3. Zoom or Meet: pick "OBS Virtual Camera". Expect webcam + overlays + QR
   readable on the receiving side (scan the QR from another laptop's screen).

## Desktop (Electron scaffold)

1. `npm run electron-dev`. First run: `npx nodejs-whisper download` if the
   model is missing.
2. Tap-to-talk (`Cmd+Alt+Space`), speak, expect a transcript-driven overlay
   (slower than web: whisper transcribes after you stop).
3. `Cmd+,`: save a Gemini key in the vault, restart, confirm it persists
   masked and the agent runs BYOK. In devtools, the agent requests go to
   `http://127.0.0.1:<port>/api/copilotkit` and carry only
   `x-capturia-provider` + `x-capturia-token`; the plaintext key must never
   appear in any request or in the renderer.
4. Drop a PDF on the deck rail; expect LLM cue cards (or deterministic
   fallback), and spoken cue aliases to fire the matching card.

## Desktop static bundle + loopback runtime (M8)

Automated pieces first: `npm run smoke:runtime` (runtime server auth/protocol
over real HTTP, no Electron) and `npm run build:electron` then
`CAPTURIA_SMOKE=1 npm run electron` (static export boots over file://, bridge
up, authenticated keycheck against the loopback runtime; exits 0 on pass).
Then by hand:

1. `npm run build:electron`, then `CAPTURIA_STATIC_UI=1 npm run electron`
   (no Next server running). The studio must load and the agent loop must run
   BYOK exactly like the dev path.
2. Confirm voting is the documented exception: without a hosted
   `NEXT_PUBLIC_CAPTURIA_ORIGIN` baked into the export, the QR/vote path
   surfaces its error instead of silently dropping votes.
