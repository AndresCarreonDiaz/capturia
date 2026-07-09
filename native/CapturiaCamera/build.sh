#!/bin/bash
# Ad-hoc assembly check for the Capturia camera extension + host app (M7b).
#
# Produces dist/Capturia Camera Host.app with the CMIO system extension
# embedded at Contents/Library/SystemExtensions/, compiled with swiftc and
# ad-hoc signed. Use it as a fast compile/bundle sanity check (works on CI,
# needs no Apple Developer account). The output CANNOT be activated: the host
# claims the restricted com.apple.developer.system-extension.install
# entitlement, and without a provisioning profile AMFI SIGKILLs it at launch.
#
# For a runnable, activatable build use build-signed.sh instead. It drives
# CapturiaCamera.xcodeproj with automatic signing and embeds real development
# provisioning profiles:
#
#   CAPTURIA_TEAM_ID=XXXXXXXXXX bash native/CapturiaCamera/build-signed.sh
#
# Run:  bash native/CapturiaCamera/build.sh
# (CAPTURIA_TEAM_ID / CAPTURIA_SIGN_IDENTITY are still honored below for a
# certificate-signed assembly without profiles, but that build is launchable
# only with the entitlement stripped; prefer build-signed.sh.)

set -euo pipefail
cd "$(dirname "$0")"

TEAM_ID="${CAPTURIA_TEAM_ID:-}"
IDENTITY="${CAPTURIA_SIGN_IDENTITY:--}"
# App-group / mach-service prefix. Real value once the personal Team ID exists.
PREFIX="${TEAM_ID:-TEAMID0000}"

EXT_ID="com.capturia.camera.extension"
HOST_ID="com.capturia.camera.host"
GROUP="${PREFIX}.com.capturia.camera"
MACH_SERVICE="${GROUP}.frames"
VERSION="0.1.0"
MIN_OS="13.0"
SDK="$(xcrun --sdk macosx --show-sdk-path)"

DIST="dist"
APP="${DIST}/Capturia Camera Host.app"
SYSEX="${APP}/Contents/Library/SystemExtensions/${EXT_ID}.systemextension"

rm -rf "${DIST}"
mkdir -p "${SYSEX}/Contents/MacOS" "${APP}/Contents/MacOS"

echo "== compiling extension =="
# -parse-as-library: the extension uses @main (required by the Xcode build,
# where top-level code is only allowed in main.swift).
xcrun swiftc -swift-version 5 -O -parse-as-library \
  -target "arm64-apple-macos${MIN_OS}" -sdk "${SDK}" \
  -framework CoreMediaIO -framework CoreMedia -framework CoreVideo -framework IOSurface \
  -o "${SYSEX}/Contents/MacOS/${EXT_ID}" \
  Extension/CapturiaCameraExtension.swift

echo "== compiling host harness =="
xcrun swiftc -swift-version 5 -O \
  -target "arm64-apple-macos${MIN_OS}" -sdk "${SDK}" \
  -framework SystemExtensions \
  -o "${APP}/Contents/MacOS/CapturiaCameraHost" \
  HostApp/main.swift

echo "== writing Info.plists =="
cat > "${SYSEX}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${EXT_ID}</string>
  <key>CFBundleName</key><string>Capturia Camera</string>
  <key>CFBundleExecutable</key><string>${EXT_ID}</string>
  <key>CFBundlePackageType</key><string>SYSX</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_OS}</string>
  <key>NSSystemExtensionUsageDescription</key>
  <string>Capturia provides a virtual camera so your calls can show AI-composed overlays.</string>
  <key>CMIOExtension</key>
  <dict>
    <key>CMIOExtensionMachServiceName</key><string>${MACH_SERVICE}</string>
  </dict>
</dict>
</plist>
PLIST

cat > "${APP}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${HOST_ID}</string>
  <key>CFBundleName</key><string>Capturia Camera Host</string>
  <key>CFBundleExecutable</key><string>CapturiaCameraHost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_OS}</string>
  <key>LSUIElement</key><true/>
  <key>NSSystemExtensionUsageDescription</key>
  <string>Capturia installs a virtual camera so your calls can show AI-composed overlays.</string>
</dict>
</plist>
PLIST

echo "== writing entitlements =="
cat > "${DIST}/extension.entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.application-groups</key>
  <array><string>${GROUP}</string></array>
</dict>
</plist>
PLIST

cat > "${DIST}/host.entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.system-extension.install</key><true/>
  <key>com.apple.security.application-groups</key>
  <array><string>${GROUP}</string></array>
</dict>
</plist>
PLIST

echo "== signing (identity: ${IDENTITY}) =="
codesign --force --options runtime \
  --entitlements "${DIST}/extension.entitlements" \
  --sign "${IDENTITY}" "${SYSEX}"
codesign --force --options runtime \
  --entitlements "${DIST}/host.entitlements" \
  --sign "${IDENTITY}" "${APP}"

echo "== verify =="
codesign -dv "${APP}" 2>&1 | grep -E 'Identifier|TeamIdentifier|Signature'
codesign -dv "${SYSEX}" 2>&1 | grep -E 'Identifier|TeamIdentifier|Signature'
echo
echo "Built: ${APP}"
if [ -z "${TEAM_ID}" ]; then
  echo "NOTE: ad-hoc signed. Bundle assembly is valid, but this build cannot"
  echo "launch or activate (no provisioning profile). For a signed, runnable"
  echo "build use: CAPTURIA_TEAM_ID=XXXXXXXXXX bash native/CapturiaCamera/build-signed.sh"
fi
