#!/bin/bash
# Mints and extracts the DEVELOPMENT provisioning profile for the Electron
# desktop app (bundle id com.capturia.desktop) carrying the restricted
# com.apple.developer.system-extension.install entitlement (M8 slice 2).
#
# Why: the packaged Capturia.app can only activate its embedded CMIO camera
# extension when its signature claims that entitlement AND an embedded
# provisioning profile authorizes it; AMFI SIGKILLs the app otherwise (both
# for Apple Development and Developer ID signing; see docs/virtual-camera.md).
# Xcode automatic signing is the sanctioned way to mint development profiles,
# and it mints them per bundle id, so this drives the CapturiaDesktopShim
# target (which exists only to carry that bundle id + entitlement) and copies
# the profile Xcode embedded in the shim's build product.
#
# Requirements: same as build-signed.sh (full Xcode selected, a logged-in
# Apple ID with an active membership, CAPTURIA_TEAM_ID in the environment;
# the team id never enters the repo).
#
# Run:  CAPTURIA_TEAM_ID=XXXXXXXXXX bash native/CapturiaCamera/mint-desktop-profile.sh
# Then: CAPTURIA_PROVISIONING_PROFILE=native/CapturiaCamera/dist-profile/com.capturia.desktop.dev.provisionprofile \
#       CSC_NAME=... CAPTURIA_TEAM_ID=... npm run pack:mac
#
# Distribution note: this mints a DEVELOPMENT profile (tied to this machine's
# development certificate). Developer ID distribution needs a Developer ID
# Application provisioning profile with the System Extension capability from
# the developer portal instead; the pack contract is identical (point
# CAPTURIA_PROVISIONING_PROFILE at it).

set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${CAPTURIA_TEAM_ID:-}" ]; then
  echo "ERROR: CAPTURIA_TEAM_ID is not set." >&2
  echo "Set it to your Apple Developer Team ID and re-run:" >&2
  echo "  CAPTURIA_TEAM_ID=XXXXXXXXXX bash native/CapturiaCamera/mint-desktop-profile.sh" >&2
  exit 1
fi

APP_ID="com.capturia.desktop"
DIST="dist-profile"
DERIVED="DerivedData"

echo "== xcodebuild (automatic provisioning, shim target) =="
xcodebuild \
  -project CapturiaCamera.xcodeproj \
  -scheme CapturiaDesktopShim \
  -configuration Release \
  -derivedDataPath "${DERIVED}" \
  -destination "platform=macOS" \
  DEVELOPMENT_TEAM="${CAPTURIA_TEAM_ID}" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build

SHIM="${DERIVED}/Build/Products/Release/CapturiaDesktopShim.app"
PROFILE="${SHIM}/Contents/embedded.provisionprofile"

if [ ! -f "${PROFILE}" ]; then
  echo "ERROR: the shim build embedded no provisioning profile." >&2
  echo "Check the Xcode account session and team id, then re-run." >&2
  exit 1
fi

echo "== verify: profile authorizes the entitlement for ${APP_ID} =="
DECODED="$(security cms -D -i "${PROFILE}" 2>/dev/null)"
if ! echo "${DECODED}" | grep -q "com.apple.developer.system-extension.install"; then
  echo "ERROR: profile lacks com.apple.developer.system-extension.install." >&2
  exit 1
fi
if ! echo "${DECODED}" | grep -q "${CAPTURIA_TEAM_ID}.${APP_ID}"; then
  echo "ERROR: profile app id is not ${CAPTURIA_TEAM_ID}.${APP_ID}." >&2
  exit 1
fi

mkdir -p "${DIST}"
OUT="${DIST}/${APP_ID}.dev.provisionprofile"
cp "${PROFILE}" "${OUT}"
echo
echo "Minted: $(pwd)/${OUT}"
echo "Next:   CAPTURIA_PROVISIONING_PROFILE=native/CapturiaCamera/${OUT} CSC_NAME=... CAPTURIA_TEAM_ID=... npm run pack:mac"
