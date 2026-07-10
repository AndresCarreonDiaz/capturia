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
2. **Open Capturia's Program Output.** In the studio (`npm run electron-dev`, or
   the web app at `/studio`), click **Output** in the top-right, or press
   **Cmd+Shift+O**, or open `/studio?out=1`. This hides every control and shows
   only your camera and the overlays, the clean feed.
3. **Capture it in OBS.** In OBS, under Sources, click **+** and add a
   **Window Capture** (or **macOS Screen Capture**) and pick the Capturia
   window. Resize it to fill the canvas.
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
reports "extension not found" (visible in the tray toggle doing nothing more
than retrying discovery) and everything else keeps working; use the OBS bridge
above instead. `CAPTURIA_CAMERA_LOG=1` makes main log pump stats every 5s.

Current limitation: the offscreen Program Output page is its own studio
instance, so overlays driven in the Control Room window do not yet appear on
the native camera feed (they do on the OBS bridge, which captures the visible
window). Mirroring the live overlay state into the camera page is the next
milestone; until then the native camera publishes the webcam layer.
