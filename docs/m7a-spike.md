# M7a spike: offscreen Electron -> IOSurface camera frames

**Verdict (2026-07-02): GO.** The riskiest bet of the desktop re-architecture
holds: a hidden offscreen BrowserWindow rendering the real Program Output page
(`/studio?out=1`) delivers 1920x1080 BGRA IOSurfaces at a sustained 30fps with
negligible CPU. This is exactly the input the CMIO camera extension's sink
stream consumes, so the remaining M7b work is packaging, not physics.

## Measured results (M2-class MacBook, Electron 42.2.0)

| Check | Fake camera (30fps) | Real FaceTime camera |
| --- | --- | --- |
| getUserMedia renders in the offscreen page | pass (6/593 blank warm-up frames) | pass (6/529 blank) |
| Sustained paint rate | min/median/avg 30/30/30 fps | 28/29/29.2 fps (camera cadence) |
| Frame format/size | BGRA 1920x1080 | BGRA 1920x1080 |
| Copy into owned IOSurface ring | avg 1.7ms/frame (CPU memcpy) | same |
| Time to first paint | ~170ms | similar |
| Process CPU (getAppMetrics) | under 1% reported per process | same |

Notes:
- Paint is damage-driven, so the paint rate follows the animating content (the
  webcam layer). Chromium's FAKE camera defaults to 20fps, which is why the
  spike pins it to `fps=30`; real webcams deliver ~30. The production frame
  server will re-emit the last frame on a fixed cadence anyway.
- The 1.7ms CPU row-copy is already fine (about 5% of one core at 30fps). A
  Metal blit can replace it later if 60fps or 4K raises the bill.
- PNG snapshots land in `.spike-out/` for visual verification (fake-cam run
  shows the Chromium test pattern composited full-bleed by the studio page).

## How to re-run

```
npm run dev                                   # studio must be serving
CAPTURIA_FAKE_CAM=1 npx electron electron/spike-frames.js   # no TCC prompt
npx electron electron/spike-frames.js                        # real camera
```

Exit code 0 = all gates pass; the JSON report prints to stdout. Knobs:
`CAPTURIA_SPIKE_URL`, `CAPTURIA_SPIKE_SECONDS`, `CAPTURIA_SPIKE_FPS`,
`CAPTURIA_SPIKE_OUT`.

## Pieces built

- `native/capturia-frames/`: N-API C++ addon (builds with Command Line Tools,
  no Xcode): `init(w,h)` allocates a triple-buffered owned IOSurface ring,
  `pushFrame(handleBuffer)` copies Electron's per-paint IOSurface into the
  ring, `snapshot(path)` writes PNG, `stats()` aggregates. Build:
  `cd native/capturia-frames && npx node-gyp rebuild`.
- `electron/spike-frames.js`: standalone Electron main that wires
  `webPreferences.offscreen.useSharedTexture` paint events
  (`event.texture.textureInfo.handle.ioSurface`, released immediately after
  the synchronous copy) into the addon and evaluates the gates.

## What M7b consumes from this

The ring surfaces are IOSurfaces created in the host process; the CMIO
extension's sink stream takes `CMSampleBufferCreateForImageBuffer` over
IOSurface-backed CVPixelBuffers, enqueued via `CMIOStreamCopyBufferQueue` +
`CMSimpleQueueEnqueue` (the OBS pattern). Add a fixed-cadence timer
(repeat-last-frame) in the addon and the frame server is done. M7b needs full
Xcode (extension bundle + signing) and the Apple Developer team for the
`com.apple.developer.system-extension.install` entitlement.
