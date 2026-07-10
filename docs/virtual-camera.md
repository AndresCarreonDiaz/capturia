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

### Packaged builds

`npm run pack:mac` ships the whole native camera stack inside Capturia.app:
the capturia-frames addon and the capturia-speech helper land in
`Contents/Resources`, and the CMIO camera extension is embedded at
`Contents/Library/SystemExtensions`. Signing is driven entirely by the
environment so nothing identity-like lives in the repo:

```
CSC_NAME="Your Name" CAPTURIA_TEAM_ID=XXXXXXXXXX npm run pack:mac
```

`CSC_NAME` is the keychain identity WITHOUT its certificate-type prefix
(electron-builder resolves Developer ID Application certificates first);
`CAPTURIA_TEAM_ID` lets the pack build and verify the embedded extension via
`native/CapturiaCamera/build-signed.sh`. With neither set you get the
explicit ad-hoc fallback: an unsigned but runnable app, no extension build,
no keychain surprises (CI-safe). `node scripts/smoke-packaged-app.mjs` boots
the packaged app headlessly, asserts the extension-activation status mapping,
and, when the extension is enabled on the machine, asserts the camera feed
connects and pumps.

Until notarization credentials exist, `spctl --assess` rejects the signed
app; that only gates downloads from the internet, not local runs.

### In-app extension activation (M8 slice 2)

The packaged app can install its own embedded extension: a first-run
onboarding step and the tray's "Install camera" item submit an
`OSSystemExtensionRequest` from Electron main through the
`native/capturia-sysext` addon, walk the System Settings approval with the
user, and report "Camera installed" once `systemextensionsctl` says
activated+enabled (at which point the feed auto-connects). macOS only
accepts that request from an app running in `/Applications`
(`OSSystemExtensionErrorDomain` code 3 otherwise; the app offers the move
instead of firing into that wall) that embeds the extension under
`Contents/Library/SystemExtensions` and claims the
`com.apple.developer.system-extension.install` entitlement.

**The signing contract, and why (verified 2026-07):**

- `com.apple.developer.system-extension.install` is a RESTRICTED entitlement:
  it must be authorized by a provisioning profile for every signing flavor.
  There is no bare-Developer-ID shortcut: a Developer ID signed binary
  claiming it without an embedded profile is SIGKILLed by AMFI before
  `main()` (empirically reproduced on macOS 26; Apple's TN3125 and DTS
  confirm the rule). This is exactly why the dev host app is built by Xcode
  automatic signing (`build-signed.sh`), which mints and embeds the profile.
- OBS Studio, the production precedent, ships the same way: OBS.app carries
  the entitlement in its signature (their
  `entitlements-extension.plist`) plus the Xcode-style
  `com.apple.application-identifier`/`team-identifier` claims, and embeds a
  Developer ID provisioning profile (`Contents/embedded.provisionprofile`,
  `ProvisionsAllDevices=true`) that authorizes the entitlement; without a
  profile their build system disables the camera extension feature entirely.
- Development signing (this machine's flow): a development profile for the
  DESKTOP bundle id (`com.capturia.desktop`) carrying the entitlement is
  minted by `native/CapturiaCamera/mint-desktop-profile.sh`, which builds the
  `CapturiaDesktopShim` Xcode target (that target exists only to carry the
  bundle id + entitlement) with `-allowProvisioningUpdates` and extracts the
  embedded profile. Wildcard team profiles never carry restricted
  entitlements, so the per-bundle-id mint is unavoidable.
- Developer ID distribution: create a "Developer ID Application" provisioning
  profile with the System Extension capability in the developer portal; the
  pack contract below is identical.

```
bash native/CapturiaCamera/mint-desktop-profile.sh   # needs CAPTURIA_TEAM_ID
CAPTURIA_PROVISIONING_PROFILE=native/CapturiaCamera/dist-profile/com.capturia.desktop.dev.provisionprofile \
CSC_NAME="Your Name" CAPTURIA_TEAM_ID=XXXXXXXXXX npm run pack:mac
```

With `CAPTURIA_PROVISIONING_PROFILE` set, `pack:mac` signs the app with a
GENERATED entitlements file (the committed base plus the entitlement and the
application-identifier claims; the committed plist deliberately omits the
entitlement so profile-less signed packs keep launching) and embeds the
profile via electron-builder's `mac.provisioningProfile`. Without it,
everything signs as before and the install UI reports itself unavailable;
already-activated extensions keep working either way.

Activation semantics worth knowing: an activation request for an extension
that is already active with the SAME version completes quietly (no approval,
no re-stage); a DIFFERENT version triggers the replacement flow (the app
answers "replace", and a same-team replacement of an already-approved
extension does not re-prompt). Upgrades ride exactly that: at launch, a
capable build compares the version embedded in the bundle against the
enabled one from `systemextensionsctl list` and, when they differ,
auto-submits the activation request once per run (the OBS launch pattern),
so shipping a new extension version inside a new app build is all an upgrade
takes. Matching versions never fire a request, and an unreadable version
never triggers a surprise replacement. The unpackaged dev shell
(`npm run electron`) can never request activation (unsigned, no embedded
extension), hides the install UI, and keeps using the dev host app flow
(`native/CapturiaCamera`, `build-signed.sh` then `CapturiaCameraHost
activate`).

Current limitations:
- One sink client at a time: the extension keeps a single sink client, so do
  not run `electron/spike-frames.js` with `CAPTURIA_SINK=1` while the app is
  feeding the camera. If another client does steal the sink, the app detects
  the stall (queue pinned full, nothing consumed for a few seconds) and
  reconnects automatically.
