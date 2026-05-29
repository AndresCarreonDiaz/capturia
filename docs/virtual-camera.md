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

## Coming later (the real product): a native "Capturia" camera

The goal is for **Capturia** to appear directly in every call app's camera list,
no OBS in between. On macOS that is a Core Media I/O **Camera Extension**, which
requires:

- A paid **Apple Developer account** ($99/year).
- A Developer ID certificate, the `com.apple.developer.system-extension.install`
  entitlement, and notarization of the signed app.

The extension will capture the same **Program Output** feed this OBS bridge
captures, so nothing about how you use Capturia changes, the "OBS Virtual Camera"
entry just becomes "Capturia". This ships once Apple Developer enrollment is done.
