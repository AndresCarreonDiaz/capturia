#!/bin/bash
# Signed build of the Capturia camera host app + CMIO system extension (M7b).
#
# Drives the Xcode project with automatic signing so real development
# provisioning profiles (carrying com.apple.developer.system-extension.install
# and the team-prefixed app group) get minted and embedded. Without those
# profiles the host binary is SIGKILLed by AMFI at launch because it claims a
# restricted entitlement; this is why plain build.sh output cannot activate.
#
# Requirements:
#   - Full Xcode selected (xcode-select -p points into Xcode.app).
#   - An Apple ID with an active Apple Developer membership signed into Xcode
#     (Settings > Accounts) so -allowProvisioningUpdates can register the
#     bundle ids and mint profiles.
#   - CAPTURIA_TEAM_ID set to that membership's Team ID. The team id is
#     deliberately never committed to this public repo; it enters the build
#     only through this environment variable.
#
# Run:  CAPTURIA_TEAM_ID=XXXXXXXXXX bash native/CapturiaCamera/build-signed.sh
# Then: cp -R "native/CapturiaCamera/dist-signed/CapturiaCameraHost.app" /Applications/
#       "/Applications/CapturiaCameraHost.app/Contents/MacOS/CapturiaCameraHost" activate

set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${CAPTURIA_TEAM_ID:-}" ]; then
  echo "ERROR: CAPTURIA_TEAM_ID is not set." >&2
  echo "Set it to your Apple Developer Team ID and re-run:" >&2
  echo "  CAPTURIA_TEAM_ID=XXXXXXXXXX bash native/CapturiaCamera/build-signed.sh" >&2
  exit 1
fi

EXT_ID="com.capturia.camera.extension"
DIST="dist-signed"
DERIVED="DerivedData"

rm -rf "${DIST}"
mkdir -p "${DIST}"

echo "== xcodebuild (automatic provisioning) =="
xcodebuild \
  -project CapturiaCamera.xcodeproj \
  -scheme CapturiaCameraHost \
  -configuration Release \
  -derivedDataPath "${DERIVED}" \
  -destination "platform=macOS" \
  DEVELOPMENT_TEAM="${CAPTURIA_TEAM_ID}" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build

APP_SRC="${DERIVED}/Build/Products/Release/CapturiaCameraHost.app"
cp -R "${APP_SRC}" "${DIST}/"
APP="${DIST}/CapturiaCameraHost.app"
SYSEX="${APP}/Contents/Library/SystemExtensions/${EXT_ID}.systemextension"

echo "== verify: signatures =="
codesign --verify --deep --strict "${APP}"
codesign -dv "${APP}" 2>&1 | grep -E 'Identifier|TeamIdentifier|Signature'
codesign -dv "${SYSEX}" 2>&1 | grep -E 'Identifier|TeamIdentifier|Signature'

echo "== verify: embedded provisioning profiles =="
for PROFILE in \
  "${APP}/Contents/embedded.provisionprofile" \
  "${SYSEX}/Contents/embedded.provisionprofile"; do
  if [ ! -f "${PROFILE}" ]; then
    echo "ERROR: missing ${PROFILE}" >&2
    echo "Signing produced no provisioning profile; the app would be killed" >&2
    echo "at launch. Check the Xcode account session and team id." >&2
    exit 1
  fi
  echo "${PROFILE}:"
  security cms -D -i "${PROFILE}" 2>/dev/null \
    | plutil -extract Entitlements xml1 -o - - \
    | grep -E 'system-extension|application-groups|application-identifier' || true
done

# The host profile must authorize the restricted system-extension entitlement;
# without it AMFI SIGKILLs the app the moment it launches.
if ! security cms -D -i "${APP}/Contents/embedded.provisionprofile" 2>/dev/null \
  | grep -q "com.apple.developer.system-extension.install"; then
  echo "ERROR: host profile lacks com.apple.developer.system-extension.install" >&2
  exit 1
fi

# The team-prefixed app group (TEAMID.com.capturia.camera) lives in the code
# signature, not the profile: macOS authorizes app groups locally when their
# prefix equals the signing team id, so development profiles never list them.
echo "== verify: app group in both code signatures =="
for BUNDLE in "${APP}" "${SYSEX}"; do
  if ! codesign -d --entitlements - "${BUNDLE}" 2>/dev/null \
    | grep -q "com.capturia.camera"; then
    echo "ERROR: ${BUNDLE} signature lacks the app group entitlement" >&2
    exit 1
  fi
done
echo "ok"

# Launch smoke test: an app claiming system-extension.install without a valid
# profile exits 137 (SIGKILL by AMFI) before main() runs. With the profile it
# must print usage and exit 0.
echo "== verify: launch (AMFI) =="
"${APP}/Contents/MacOS/CapturiaCameraHost"

echo
echo "Built: ${APP}"
echo "Next: copy the app to /Applications and run its binary with 'activate'."
