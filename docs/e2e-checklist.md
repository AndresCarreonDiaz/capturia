# Manual E2E checklist

`npm run test:e2e` covers the vote flow, the studio smoke paths, and (when a
Google key is present) one live agent turn. The paths below need real hardware
or human judgment; run them before a release-worthy merge.

## Voice loop (web, Chrome or Edge)

1. `npm run dev`, open `http://localhost:3000/studio` in Chrome (not Brave or
   Firefox; the voice button hides there by design). The stage boots in
   standby ("Your camera is off"): launch alone must never light the camera
   LED or fire the OS camera prompt.
2. Click **Go on camera**, allow the camera prompt, and expect your live feed
   to attach.
3. Enable voice (mic button or the hotkey hint), allow the mic prompt.
4. Speak: "add a lower third with the name Andres Carreon". Expect the overlay
   within ~2s, live captions while speaking, and the audio-reactive vignette
   breathing with your voice (FX pill on).
5. Say "remove everything". Stage clears with exit animations.

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

1. **Go on camera** first (a fresh studio boots in standby), then
   `Cmd+Shift+O` for the chrome-free output view. A second tab on `?out=1`
   is a mirror receiver and captures on its own; no button needed there.
2. OBS: window capture of that window, Start Virtual Camera.
3. Zoom or Meet: pick "OBS Virtual Camera". Expect webcam + overlays + QR
   readable on the receiving side (scan the QR from another laptop's screen).

## Desktop (Electron scaffold)

1. `npm run electron-dev`. First run: `npx nodejs-whisper download` if the
   model is missing. The Control Room stage boots camera-off like the web
   studio; hit **Go on camera** to see yourself (onboarding's go-live step
   walks this button).
2. Continuous voice (`Cmd+Alt+Space` toggles the session): speak, pause,
   expect a transcript-driven overlay about a second after the pause while
   the mic stays open; say a second command without touching anything and
   expect it too. Two quick commands back to back must both land, in order
   (chunks queue behind one whisper job). The feed's energy vignette should
   breathe while you speak. Toggle again to release the mic.
2a. Streaming voice (macOS 26+): with the helper built (`npm run
   build:speech`), toggle voice and speak two sentences WITHOUT pausing;
   overlays for the first sentence land while you speak the second (the
   status pill shows interim text live). On macOS <= 15 the same toggle
   uses chunked whisper and needs the pause. First streaming use may show
   "downloading speech model" once. Mic-device swap mid-session (unplug
   Bluetooth) must surface an error, not a stuck session.
2b. Say "give me two minutes on the clock": a CountdownTimer lands (green),
   turns amber at 30s left, red at 15s, pulses, then counts overtime upward
   with a plus. It ticks locally: no agent turns while it runs. "Give me
   five minutes" re-issues it fresh at 5:00.
3. `Cmd+,`: save a Gemini key in the vault, restart, confirm it persists
   masked and the agent runs BYOK. In devtools, the agent requests go to
   `http://127.0.0.1:<port>/api/copilotkit` and carry only
   `x-capturia-provider` + `x-capturia-token`; the plaintext key must never
   appear in any request or in the renderer.
4. Drop a PDF on the deck rail; expect LLM cue cards (or deterministic
   fallback), and spoken cue aliases to fire the matching card.
4a. Interim cue firing (streaming engines: macOS 26+ desktop, or Chrome on
   the web studio): with a deck loaded, say a long sentence containing a
   cue alias early ("our revenue this year, and I want to spend a minute
   here, grew a lot"). The primed card must land while you are still
   mid-sentence (about a beat after the alias: it fires once the next
   words confirm it), and must NOT re-fire or flicker as the interim text
   keeps growing. With a deck containing both a "Next Steps" and a "Next
   Quarter Plan" slide, saying "the next quarter plan is simple" must fire
   ONLY the quarter-plan card: not the steps card first while the
   hypothesis grows, and not the steps card after the sentence final
   lands either. One cue fires per breath BY DESIGN: naming two cards in
   one uninterrupted sentence shows only the first; pause briefly and say
   the second cue to fire it. On chunked whisper (macOS <= 15) the same
   sentence fires the card only after the pause; that is expected.

4b. Silent cue hotkeys: with the deck from step 4 loaded, focus Zoom (or any
   other app) and press `Cmd+Alt+1`: the first rail card lands on the feed
   WITHOUT Capturia focused. `Cmd+Alt+Right` walks the remaining cards in
   rail order and goes quiet after the last one (no wrap). Clear the deck
   and confirm both combos stop doing anything system-wide (nothing stays
   registered). `node scripts/e2e-desktop-hotkeys.mjs` automates the
   register/fire/release lifecycle; only the real OS-level keypress from
   another app needs this manual pass.

## Native Capturia camera (M7b, requires the installed extension)

1. With the Capturia camera extension installed and approved (see
   `native/CapturiaCamera/`), `npm run electron-dev`. The tray menu shows
   **Camera: On** within a few seconds of launch (`CAPTURIA_CAMERA_LOG=1`
   prints pump stats every 5s if you want proof in the terminal), but the
   pump BOOTS paused: the Mac's green camera LED stays dark and the feed
   pumps the branded "Capturia standing by" card until a call app actually
   attaches (launch is not capture intent; issue #38's rule applied to boot).
2. Open Photo Booth (or Zoom's camera picker) and select **Capturia** while
   the app runs. Attaching is what engages the webcam: expect the standby
   card to flip to the live Program Output (webcam feed at 1080p30, LED on)
   within ~2s, not the extension's dark scanline splash.
3. Tray > Camera: Off. The picker's Capturia feed drops back to the splash
   within a second; Camera: On resumes the live feed.
4. Quit the app. The splash returns (clean sink disconnect, no frozen last
   frame), and a relaunch resumes feeding without a reboot or extension
   restart.
5. Privacy idle (issue #38): close the Photo Booth/Zoom consumer and hide the
   Capturia window to the tray. Within ~15s the Mac's green camera LED goes
   dark (the terminal logs "releasing the webcam capture"). Re-select
   Capturia in Photo Booth: the feed shows the "Capturia standing by" card,
   then live video within ~2s, and the LED lights again. Tray > Camera: Off
   with the window hidden must also leave the LED dark.

## Desktop static bundle + loopback runtime (M8)

Automated pieces first: `npm run smoke:runtime` (runtime server auth/protocol
over real HTTP, no Electron) and `npm run build:electron` then
`CAPTURIA_SMOKE=1 npm run electron` (static export boots over file://, bridge
up, authenticated keycheck against the loopback runtime; exits 0 on pass).
Then by hand:

1. `npm run build:electron`, then `CAPTURIA_STATIC_UI=1 npm run electron`
   (no Next server running). The studio must load and the agent loop must run
   BYOK exactly like the dev path.
2. Voting from the packaged app targets the hosted deploy (issue #52):
   `npm run build:electron` bakes `NEXT_PUBLIC_CAPTURIA_ORIGIN` as
   `https://www.capturia.dev` unless the env sets it (a SET-but-empty var
   disables it). Prerequisite: that deploy must have its Redis vote backend
   provisioned and certified FIRST (docs/release.md, "Before any release");
   a serverless deploy without it falls back to the in-memory store, which
   does not survive across invocations, so this whole step fails with
   phones stuck on the waiting screen under a confident-looking QR.
   Toggle Vote on: the QR must render over the feed, a phone
   scanning it lands on `www.capturia.dev/vote/<room>` and its votes move
   the on-feed tally; toggling Vote off returns the phone to its waiting
   screen within a few seconds. A build with the var explicitly emptied
   must still surface the origin notice instead of silently dropping votes.

## Menu-bar shell (M8, tray)

1. `npm run electron-dev`. A Capturia camera glyph appears in the menu bar;
   its first menu line reads "Capturia: starting", flips to "Capturia: idle"
   once the studio mounts, and the Start Listening item enables.
2. Start Listening from the tray: the studio's voice loop starts and the
   status line reads "Capturia: listening"; Stop Listening reverses it. The
   `Cmd+Alt+Space` hotkey and the tray stay in sync whichever one toggles.
3. Close the Control Room window: the app stays alive in the menu bar, the
   dock icon disappears, and voice keeps working while hidden (toggle via
   hotkey, speak, reopen and confirm the overlay landed). "Open Control Room"
   brings the window and dock icon back.
4. Tray > Settings opens the Control Room with the settings sheet up, even
   when clicked immediately after launch (the action is parked until the
   page mounts, then delivered).
5. Fullscreen the Control Room, then close it: the window leaves fullscreen
   before hiding (no stranded empty macOS Space).
6. Reload the studio (View > Reload): the tray drops back to "Capturia:
   starting" with the toggle disabled, then recovers to "Capturia: idle"
   when the page remounts.
7. Quit from the tray: the app exits fully (no lingering menu-bar icon, no
   process).

## Packaged app (M8, unsigned)

Automated: `npm run pack:mac` (static export + gen libs + electron-builder;
prints a whisper provisioning warning if whisper-cli or the ggml model is
missing from node_modules/nodejs-whisper), then
`CAPTURIA_SMOKE=1 ./dist-app/mac-arm64/Capturia.app/Contents/MacOS/Capturia`
(must print `[smoke] PASS`: static UI from inside the asar + preload bridge +
authenticated loopback keycheck). Then by hand:

1. Double-click Capturia.app: tray + Control Room appear, agent loop runs
   BYOK exactly like the dev path (macOS will warn on first open while the
   app is unsigned; right-click > Open).
2. Voice transcription in the packaged app requires whisper provisioned
   BEFORE packing (`npx nodejs-whisper download`); without it, expect the
   provisioning error from the mic path, and everything else keeps working.
3. Keys saved in the packaged app persist across relaunches (safeStorage
   vault lives in the packaged app's userData, separate from dev's).

## Capturia Pro upgrade flow (M11 slice 2)

Local rails first: dev server on :3000 with the Stripe env (secret key,
price id, webhook secret) plus the JWT keypair, a webhook route reachable by
Stripe (tunnel or deployed), and the app launched with
`CAPTURIA_HOSTED_URL=http://localhost:3000/api/hosted` so checkout,
activation, token refresh, and the proxy all hit the same server.

1. Settings (Cmd+,) > Capturia Pro row shows "Upgrade to Pro". Click: the
   Stripe Checkout page opens in the default browser and the row reports
   that checkout opened.
2. Pay. Stripe redirects to the landing, which overlays "Payment received"
   and then the activation code with a Copy button (webhook lag of a few
   seconds is absorbed; the code appears without a refresh).
3. Refresh that success page: the overlay now says the code was already
   collected (pickup is exactly-once), with the support path spelled out.
4. Paste the code in the Capturia Pro row and Activate: the row flips to
   the stored-credential mask, Capturia Pro becomes the active model, and
   no token was ever visible or pasted by hand.
5. Talk to the camera: overlays render through the hosted proxy on
   Capturia's key (no BYOK key stored for the session). The webhook log on
   the dev server shows `activation_minted`; Stripe Dashboard > Billing >
   Meters accumulates capturia_hosted_tokens after generations.
6. Clear the Capturia Pro row: hosted calls stop within one JWT lifetime
   (the refresh token and its timer are dropped with the JWT), and
   re-activating requires a fresh code (402/403 responses put a still-valid
   code back for retry).
7. Relaunch the app: the JWT is refreshed from the stored refresh token at
   boot with no user action (check the row is still active after a restart
   that outlives the ~1h token).
