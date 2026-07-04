#!/bin/bash
# Assemble the Capturia camera extension + host harness app (M7b).
#
# Produces dist/Capturia Camera Host.app with the CMIO system extension
# embedded at Contents/Library/SystemExtensions/. Everything compiles and
# assembles with Xcode's toolchain alone; SIGNING decides whether macOS will
# actually load it:
#
#   CAPTURIA_TEAM_ID unset  -> ad-hoc signing ("-"). Assembly/bundle sanity
#                              only; activation WILL be rejected by macOS.
#   CAPTURIA_TEAM_ID=XXXXXXXXXX (Andres's PERSONAL team, NEVER the Exodus
#                              Movement work team) + CAPTURIA_SIGN_IDENTITY
#                              ("Apple Development: ..." cert from that team)
#                              -> real signing; requires provisioning profiles
#                              carrying the system-extension entitlement once
#                              the membership is active.
#
# Run:  bash native/CapturiaCamera/build.sh
# Then: cp -R dist/"Capturia Camera Host.app" /Applications/ and run
#       ".../Contents/MacOS/CapturiaCameraHost activate"

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
xcrun swiftc -swift-version 5 -O \
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
  echo "NOTE: ad-hoc signed. Bundle assembly is valid, but macOS will refuse"
  echo "activation until it is re-signed with the personal team's identity and"
  echo "provisioning profiles (set CAPTURIA_TEAM_ID + CAPTURIA_SIGN_IDENTITY)."
fi
