#!/bin/bash
# Assembles Pull Deck.app.
#
# SwiftPM produces bare executables; a menu bar app needs a bundle with an
# Info.plist (LSUIElement is what keeps it out of the Dock). No Xcode required —
# Command Line Tools is enough.
set -euo pipefail

cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="build/Pull Deck.app"
BIN_DIR="$APP/Contents/MacOS"
RES_DIR="$APP/Contents/Resources"

echo "==> Building ($CONFIG)"
swift build -c "$CONFIG"
BUILT="$(swift build -c "$CONFIG" --show-bin-path)"

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$BIN_DIR" "$RES_DIR"

cp "$BUILT/PullDeckApp" "$BIN_DIR/PullDeckApp"
# The relay lives inside the bundle so the host manifest can point at a stable
# absolute path that moves with the app.
cp "$BUILT/pulldeck-bridge" "$BIN_DIR/pulldeck-bridge"

if [ -f ../icons/icon128.png ]; then
  cp ../icons/icon128.png "$RES_DIR/icon.png"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Pull Deck</string>
  <key>CFBundleDisplayName</key><string>Pull Deck</string>
  <key>CFBundleIdentifier</key><string>com.pulldeck.app</string>
  <key>CFBundleExecutable</key><string>PullDeckApp</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu bar only: no Dock icon, no app switcher entry. -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signature. Enough for a locally built app; Developer ID and
# notarization would only matter for distributing it to someone else.
echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "    (codesign unavailable, continuing unsigned)"

echo
echo "Built: $(pwd)/$APP"
echo "Relay: $(pwd)/$BIN_DIR/pulldeck-bridge"
echo
echo "Next: ./install-host.sh <extension-id>"
