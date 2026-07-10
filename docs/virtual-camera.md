# Capturia as a camera in Zoom, Teams, and Meet

Capturia composites your webcam and the AI overlays into one feed. To show that
feed inside a video call, it has to be published as a camera device the call app
can pick. There are two ways to do that.

## Today (no Apple Developer account needed): the OBS bridge

This works right now on macOS using OBS Studio's built-in virtual camera. No
plugin, no developer account.

1. **Install OBS Studio** (free): https://obsproject.com. Version 26.1 or newer
   has the virtual camera built in. On first launch, grant it Screen Recording
   and Camera permission in System Settings, Privacy and Security.
2. **Open Capturia's Program Output.** Two ways:
   - In the studio (`npm run electron-dev`, or the web app at `/studio`), click
     **Output** in the top-right or press **Cmd+Shift+O**. This hides every
     control and shows only your camera and the overlays, the clean feed.
   - Or keep your studio tab as-is and open `/studio?out=1` in a **second tab
     of the same browser**: it mirrors the studio tab's overlays live over a
     BroadcastChannel, so you can keep driving from the first tab while OBS
     captures the second. (Exiting Program Output on such a tab reloads it as
     a regular Control Room.)
3. **Capture it in OBS.** In OBS, under Sources, click **+** and add a
   **Window Capture** (or **macOS Screen Capture**) and pick the Capturia
   window or the `?out=1` browser tab's window. Resize it to fill the canvas.
   Do **not** use an OBS **Browser Source** pointed at `/studio?out=1`: OBS's
   Browser Source is its own embedded browser, not a tab of yours, so it
   cannot receive the mirror and would only ever show the bare webcam.
4. **Start the virtual camera.** In OBS, click **Start Virtual Camera**
   (bottom-right Controls panel).
5. **Pick it in your call.** In Zoom: Settings, Video, Camera, choose
   **OBS Virtual Camera**. Same idea in Teams and Meet (camera dropdown). You now
   see your webcam with Capturia's overlays on it.
6. **Drive overlays during the call.** On the desktop app, the global push to
   talk hotkey **Cmd+Alt+Space** toggles voice from anywhere, so you can add
   overlays mid-call without leaving Program Output. Cues from a loaded deck can
   also be triggered by voice.

Tip: load your pitch deck before going into Output mode so your cue cards and
deck numbers are ready, then switch to Output for the clean feed.

## The native path (desktop app): the "Capturia" camera

With the Capturia camera extension installed and approved (see
`native/CapturiaCamera/`, built and signed via its `build-signed.sh`; it needs
a Developer ID certificate and the system-extension entitlement), **Capturia**
appears directly in every call app's camera list. No OBS in between.

How it works while the desktop app (`npm run electron`) runs:

1. Electron main opens a hidden **offscreen window** on the studio's Program
   Output view (`?out=1`, the same chrome-free page the OBS bridge captures),
   rendered at 1920x1080 in GPU shared-texture mode.
2. Every painted frame's IOSurface is copied into a native ring buffer
   (`native/capturia-frames`), and a fixed 30fps pump delivers the freshest
   frame into the camera extension's sink stream (repeat-last-frame, so the
   camera never freezes to black when nothing repaints).
3. The tray menu's **Camera: On/Off** item mirrors and toggles the feed; it is
   on by default for the app's whole lifetime and disconnects cleanly on quit
   (the extension then shows its animated splash again).

If the extension is not installed, the app degrades gracefully: the feed
reports "extension not found" (the tray shows Camera: Error and a click
retries discovery) and everything else keeps working; use the OBS bridge
above instead. While the page is still loading or the sink is connecting the
tray reads "Camera: Connecting…" and a click cancels; a page that stops
painting flips the label to "Camera: Frozen" so a stuck feed never
masquerades as healthy. `CAPTURIA_CAMERA_LOG=1` makes main log pump stats
every 5s.

How the Control Room's overlays reach the camera: the offscreen Program
Output page is its own studio instance, so the visible window mirrors its
live state to it over a same-origin BroadcastChannel (`lib/mirror.ts`). The
Control Room (any studio page NOT loaded with `?out=1`) publishes the overlay
state, the Surface Mode flag, the FX switch, the speaking-energy heartbeat,
and the vote-room URL on every change, plus a low-rate keepalive; every
`?out=1` page adopts it, and a late-joining output page requests a snapshot
on load. The same mechanism covers a second tab of the same browser on
`/studio?out=1` (the OBS bridge flow above); the channel does NOT reach other
browsers or OBS's embedded Browser Source. Mirroring is strictly
one-directional; output pages never publish, never run speech, never open
agent runs, and never claim a vote room (they show the Control Room's QR
verbatim). The exit-output control on a `?out=1` page navigates it back to a
plain `/studio` Control Room rather than revealing dead chrome in place. If
the Control Room goes away, output pages clear the mirrored overlays:
immediately on a clean close (a goodbye message on pagehide), or within ~12s
of silence when it crashed. Known limitation: two open Control Room tabs both
publish and the last writer wins on the camera page, so keep one Control Room
per machine.

Current limitations:
- Packaged builds (`npm run pack:mac`) do not ship the capturia-frames addon
  yet (see the deferred-work notes in electron-builder.yml), so the native
  camera works from a source checkout (`npm run electron`) only; the packaged
  app reports "Native camera module not built" and degrades to the OBS
  bridge.
- One sink client at a time: the extension keeps a single sink client, so do
  not run `electron/spike-frames.js` with `CAPTURIA_SINK=1` while the app is
  feeding the camera. If another client does steal the sink, the app detects
  the stall (queue pinned full, nothing consumed for a few seconds) and
  reconnects automatically.
