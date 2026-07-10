# Releasing the desktop app (DMG + notarization)

How a distributable Capturia.dmg gets built, signed, notarized, and stapled,
and the one-time Apple account setup the account holder has to do by hand.
The day-to-day dev loop is not this document: `npm run pack:mac` stays
directory-only and `docs/virtual-camera.md` covers the packaged-app camera
stack itself.

Nothing identity-like is ever committed: certificates, team ids, profiles,
and notary credentials all enter the build through the environment or the
keychain. Keep it that way in issues and PRs too.

## The commands

```
# dev loop (unchanged): directory build only, no DMG, whisper check warns only
npm run pack:mac

# one-time before releases: provision whisper. dist:mac FAILS without it
# (check-whisper-assets --strict): a post-install model download would write
# into the sealed bundle and break its signature.
npx nodejs-whisper download

# release artifact: pack:mac + DMG + (when credentials exist) notarization
CSC_NAME="Your Name" CAPTURIA_TEAM_ID=XXXXXXXXXX \
CAPTURIA_PROVISIONING_PROFILE=path/to/com.capturia.desktop.provisionprofile \
CAPTURIA_EXT_PROVISIONING_PROFILE=path/to/com.capturia.camera.extension.provisionprofile \
CAPTURIA_NOTARY_PROFILE=capturia-notary \
npm run dist:mac

# notarize + staple an already-built dist-app (credentials arrived later)
CAPTURIA_NOTARY_PROFILE=capturia-notary npm run notarize:mac
```

`dist:mac` (scripts/dist-mac.mjs) gates on provisioned whisper
(`check-whisper-assets --strict`), runs the whole existing `pack:mac`
pipeline (assertions included), then wraps that exact app in a DMG via
`electron-builder --prepackaged` (no rebuild, no re-sign; the script asserts
CDHash equality between the packed app and the copy inside the mounted
image, plus the drag-to-Applications layout), then hands off to
`scripts/notarize-mac.mjs`. Before submitting, that script re-checks
coherence (the DMG must contain the current dist-app app, CDHash-equal) and
refuses locally when the embedded camera extension is not Developer ID
signed (see "The embedded camera extension" below).

Environment summary (the first two are the pack:mac contract, see
`scripts/pack-mac.mjs`):

| Variable | Meaning |
| --- | --- |
| `CSC_NAME` | Keychain signing identity, no certificate-type prefix. Release builds need the Developer ID Application identity to resolve (electron-builder prefers it automatically). |
| `CAPTURIA_TEAM_ID` | Apple Team ID; builds/verifies the embedded camera extension and pins the signature assertions. |
| `CAPTURIA_PROVISIONING_PROFILE` | Path to a `.provisionprofile` for `com.capturia.desktop` authorizing the system-extension entitlement (below). Without it the app still signs, but in-app camera install reports itself unavailable. |
| `CAPTURIA_EXT_PROVISIONING_PROFILE` | Path to the portal-minted **Developer ID** `.provisionprofile` for `com.capturia.camera.extension` (below). Set: the afterPack hook re-signs the embedded camera extension into the Developer ID distribution flavor (see "The embedded camera extension"). Needs the Developer ID identity in a searchable keychain: the CSC_LINK temp-keychain flow happens after the hook runs, so this step supports the `CSC_NAME` flow only. Unset: the extension ships as the dev flavor and `notarize:mac` refuses to submit a build that embeds it. |
| `CAPTURIA_EXT_SIGN_IDENTITY_SHA1` | Optional. Pins the exact Developer ID Application certificate (its SHA-1 from `security find-identity -v -p codesigning`) for the extension re-sign when two distinct certificates share a name, e.g. a renewed certificate coexisting with its predecessor; the build refuses to pick one by surprise and names this variable. |
| `CAPTURIA_NOTARY_PROFILE` | Name of a `notarytool store-credentials` keychain profile (below). Unset: notarization is skipped with a clear log line. Set: the DMG is submitted with `--wait`, rejection fails the build loudly (the developer log is printed), then app and DMG are stapled and `spctl --assess` must accept the app. |

## One-time portal setup: the Developer ID provisioning profile

Release builds of `com.capturia.desktop` need a **Developer ID** provisioning
profile that authorizes `com.apple.developer.system-extension.install` (the
restricted entitlement behind in-app camera-extension activation; see
`docs/virtual-camera.md` for why there is no profile-less shortcut). Profiles
of this type can only be created in the Apple Developer portal by hand, and
Developer ID certificates only by the **Account Holder** role.

Steps on [developer.apple.com/account](https://developer.apple.com/account),
under **Certificates, Identifiers & Profiles** (verified against Apple's
current docs, 2026-07; citations at the end). **Do them in this order**: a
capability edit on an App ID INVALIDATES every existing profile for that App
ID (Apple's own warning), so all capability edits happen first, all profile
(re)generation last, one round of breakage total.

1. **Certificate** (skip if the Developer ID Application certificate already
   exists): **Certificates** -> **+** -> under "Software" select **Developer
   ID**, type **Developer ID Application** ("A certificate used to sign a Mac
   app"). Upload a CSR from Keychain Access, download the `.cer`,
   double-click to install it in the login keychain. Creating classic
   (downloadable) Developer ID certificates requires the **Account Holder**
   role, per Apple's help page; teams are limited to 5. (Since ~2024 there
   are also cloud-managed Developer ID certificates for admins granted that
   access role; the classic flow above is what this repo's env-driven signing
   expects.)
2. **App ID capabilities, BOTH App IDs, before any profile work**:
   **Identifiers** -> select the explicit App ID (register missing ones as
   type "App" with the explicit bundle ID; the Xcode automatic-signing dev
   flows have usually registered both already):
   - `com.capturia.desktop`: enable **System Extension** -> **Save**. This
     capability is self-serve on macOS App IDs for all program types
     INCLUDING Developer ID (no request form; DriverKit is the one that
     historically required a request).
   - `com.capturia.camera.extension`: confirm **App Groups** is enabled (the
     extension claims the app sandbox + the team app group, nothing else;
     Xcode's automatic signing enabled the capability during development
     builds). The System Extension capability is the HOST app's, not the
     extension's.
   Skip the Save on any App ID whose capabilities are already right: saving a
   capability edit is what invalidates that App ID's existing profiles. If
   you did have to edit, every existing profile for that App ID (including
   the DEVELOPMENT profile minted by `mint-desktop-profile.sh`) is now
   invalid; step 4 regenerates them.
3. **Profiles** (after all capability edits): **Profiles** -> **+** -> under
   **Distribution** choose the **Developer ID** option -> Continue -> select
   the App ID -> select the Developer ID Application certificate -> name it
   -> **Generate** -> **Download**. Requires Account Holder or Admin. Do it
   once per App ID:
   - `com.capturia.desktop` (for example `Capturia Desktop Developer ID`):
     consumed by the pack as `CAPTURIA_PROVISIONING_PROFILE`.
   - `com.capturia.camera.extension` (for example `Capturia Camera Extension
     Developer ID`): consumed by the pack as
     `CAPTURIA_EXT_PROVISIONING_PROFILE` for the extension dist-signing step
     (next section); mint it in the same portal session.
   There is no dedicated help page for the Developer ID flavor; the flow is
   the same as Apple's documented App Store distribution profile, with the
   "Developer ID" radio button instead. The downloaded file is a macOS
   `.provisionprofile` (the macOS-specific extension, per TN3125), and
   Developer ID profiles are long-lived (18-year validity).
4. **Re-mint the development profile** if step 2 edited
   `com.capturia.desktop`: re-run `bash
   native/CapturiaCamera/mint-desktop-profile.sh` (Xcode automatic signing
   fetches a fresh valid dev profile) so the development pack flow keeps
   working alongside the release one.
5. **Where the files go**: anywhere OUTSIDE the repo (they embed the team id
   and certificate). The build consumes both profiles only via the
   environment: `CAPTURIA_PROVISIONING_PROFILE=/path/to/desktop.provisionprofile`
   (pack:mac embeds it at the app's `Contents/embedded.provisionprofile`, the
   documented macOS location) and
   `CAPTURIA_EXT_PROVISIONING_PROFILE=/path/to/extension.provisionprofile`
   (afterPack embeds it at the embedded extension's own
   `Contents/embedded.provisionprofile` during the dist re-sign, next
   section). The gitignored `native/CapturiaCamera/dist-profile/` directory
   used by the development mint is a reasonable local spot for all of them.
   `pack:mac` refuses desktop profiles that do not authorize
   `com.apple.developer.system-extension.install`, and extension profiles
   that are not the Developer ID flavor for the extension's App ID, so a
   mis-created profile fails the build instead of producing an app AMFI would
   kill (or a notarization rejection).

## The embedded camera extension: what ships today vs what release needs

**What exists today**: `pack:mac` embeds the CMIO camera extension built by
`native/CapturiaCamera/build-signed.sh`, which uses Xcode AUTOMATIC signing.
That flavor is signed with an **Apple Development** certificate and a
device-limited **development** provisioning profile. It is exactly right for
the dev loop (it activates on the machines in the team's device list) and
exactly wrong for distribution:

- Apple's notary service only accepts Developer ID signatures; an Apple
  Development signature on ANY nested executable gets the whole submission
  rejected ("Don't use a Mac Distribution, ad hoc, Apple Developer, or local
  development certificate", Apple's notarization doc).
- Even if it somehow passed, a development profile cannot activate on
  customer machines (they are not in the team's device list).

`scripts/notarize-mac.mjs` therefore refuses to submit a build whose embedded
extension is not Developer ID signed, with a message pointing at the release
flow below; the refusal is local and loud instead of a guaranteed-rejected
upload.

**What release runs (the dist re-sign)**: with
`CAPTURIA_EXT_PROVISIONING_PROFILE` pointing at the portal-minted Developer ID
profile for `com.capturia.camera.extension` (step 3 of the portal runbook
above), the afterPack hook re-signs the embedded COPY of the extension into
the distribution flavor via `scripts/ext-dist-sign.mjs`, leaving the dev build
in `native/CapturiaCamera/dist-signed` untouched. Concretely, the re-sign:

- embeds that profile as the extension's `Contents/embedded.provisionprofile`
  (replacing the development one),
- signs with the **Developer ID Application** identity from the keychain
  (resolved for the profile's team; `CSC_NAME`, when set, must match it), and
- regenerates the extension's entitlements: app sandbox, the team-prefixed
  app group, and the Xcode-style identity claims, dropping the
  development-only `get-task-allow` the dev flavor carries (an instant
  notarization rejection), with hardened runtime and a secure timestamp.

The step is asserted in the same fail-loudly style as the rest of the pack:
the profile must be the Developer ID flavor (all-devices, no device list) FOR
the extension's App ID and team; BEFORE the re-sign the embedded bundle's
provenance must match the signing team (its Info.plist bakes the build-time
team into `CMIOExtensionMachServiceName`, which no re-sign can fix, so a
stale `dist-signed` build from another team is refused with a rebuild
instruction instead of shipping a notarized but camera-dead artifact); and
after the re-sign the bundle must verify deep-strict with a Developer ID
signature, matching team, hardened runtime, secure timestamp, the entitlement
set above (probed structurally, key by key), and the exact profile embedded.
`pack:mac` validates the whole contract before spending minutes building, and
after packing asserts the OUTER app's signing team equals the extension
profile's (electron-builder resolves `CSC_NAME` with no team awareness, and
an app from another team could not activate its own extension).
Without the env var nothing changes: the dev flavor ships as-is (the dev loop
stays byte-identical) and `notarize:mac` keeps refusing to submit a build
that embeds it. Notarization-bound builds can also still pack WITHOUT the
embedded extension (no `CAPTURIA_TEAM_ID`, no
`native/CapturiaCamera/dist-signed` present), which notarizes fine but cannot
install its own camera.

## One-time notary setup: app-specific password + store-credentials

`notarytool` authenticates through a keychain profile created once from an
app-specific password. The password is SECRET: generate it, type it into the
interactive `store-credentials` prompt in a terminal, and never write it into
the repo, an env file, CI config, a chat, or a shell command line (command
lines end up in shell history).

1. **App-specific password**: sign in at
   [account.apple.com](https://account.apple.com) with the developer Apple
   Account -> **Sign-In and Security** -> **App-Specific Passwords** ->
   **Generate an app-specific password**, label it (for example
   `capturia-notary`). Copy it; Apple shows it once. (Up to 25 can be active;
   changing the primary Apple Account password revokes them all, so expect to
   redo this after a password change.)
2. **Store it in the keychain** (separate terminal, interactive; do not pass
   the password as a flag):

   ```
   xcrun notarytool store-credentials capturia-notary \
     --apple-id "<the developer Apple Account email>" \
     --team-id  "<the Team ID>"
   ```

   `notarytool` prompts for the app-specific password and saves everything as
   a login-keychain item; `capturia-notary` is the profile name the build
   references. Nothing secret touches disk outside the keychain.
3. **Use it**: `CAPTURIA_NOTARY_PROFILE=capturia-notary npm run dist:mac`
   (or `npm run notarize:mac` for artifacts already built). The pipeline
   submits the DMG (`xcrun notarytool submit --keychain-profile ... --wait`),
   and on `Accepted` staples the app and the DMG (`xcrun stapler staple`) and
   re-asserts `spctl --assess --type exec`, which must now report
   `accepted, source=Notarized Developer ID`. On any other status the build
   fails and prints the developer log (`xcrun notarytool log <submission-id>`
   serves the log content directly; notarytool has no separate log URL).

Notes:

- Notarization only accepts Developer ID signed, hardened-runtime,
  secure-timestamped code; `pack:mac`'s signing path provides all three.
  A pack signed with an Apple Development identity is submitted anyway (with
  a warning) so Apple's rejection log, not a local guess, is the answer.
- One submission of the DMG covers the app nested inside it (tickets are
  issued per item), which is why the same app in `dist-app` can be stapled
  afterwards even though the copy inside the read-only image cannot.
- A notarized build must ship whisper fully provisioned
  (`npx nodejs-whisper download` before packing): a post-install model
  download would write into the sealed bundle and break its signature.

## What was verified against Apple's documentation (2026-07)

- Developer ID certificates require the Account Holder role:
  https://developer.apple.com/help/account/certificates/create-developer-id-certificates
- Enabling App ID capabilities (Identifiers -> select -> Edit -> Save, and
  the profile-invalidation warning):
  https://developer.apple.com/help/account/identifiers/enable-app-capabilities
- "System Extension" is a standard self-serve macOS capability available to
  Developer ID (no request, unlike DriverKit):
  https://developer.apple.com/help/account/reference/supported-capabilities-macos
  and https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.system-extension.install
- Distribution-profile creation flow (Profiles -> + -> Distribution -> type;
  Account Holder or Admin):
  https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile
  (the Developer ID radio button has no dedicated page; type and validity per
  https://developer.apple.com/support/developer-id/)
- `.provisionprofile` extension and `Contents/embedded.provisionprofile`,
  plus "profiles only needed for restricted entitlements" (TN3125):
  https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles
- App-specific passwords (account.apple.com, Sign-In and Security, 25 max,
  revoked on password change): https://support.apple.com/en-us/102654
- `store-credentials` interactive password prompt + keychain storage, and
  `notarytool log` returning the log content (altool's LogFileURL is gone;
  altool notarization died 2023-11):
  https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool
- `submit --keychain-profile --wait`, per-item tickets for nested content,
  `stapler staple` on app/dmg:
  https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- "Notarize the outermost container", UDZO disk images, offline Gatekeeper
  needs stapling:
  https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution
- Hardened runtime + secure timestamp + Developer ID certificate are hard
  notarization requirements ("Don't use a Mac Distribution, ad hoc, Apple
  Developer, or local development certificate"):
  https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
