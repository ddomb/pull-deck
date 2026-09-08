#!/bin/bash
# Assembles Pull Deck.app.
#
# SwiftPM produces bare executables; a menu bar app needs a bundle with an
# Info.plist (LSUIElement is what keeps it out of the Dock). No Xcode required —
# Command Line Tools is enough.
set -euo pipefail

cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="${PULLDECK_APP_OUTPUT:-build/Pull Deck.app}"
BIN_DIR="$APP/Contents/MacOS"
RES_DIR="$APP/Contents/Resources"

echo "==> Building ($CONFIG)"
node ../tools/generate-config.mjs --check
swift build -c "$CONFIG"
BUILT="$(swift build -c "$CONFIG" --show-bin-path)"

echo "==> Assembling $APP"
mkdir -p "$BIN_DIR" "$RES_DIR"

cp "$BUILT/PullDeckApp" "$BIN_DIR/PullDeckApp"
# The relay lives inside the bundle so the host manifest can point at a stable
# absolute path that moves with the app.
cp "$BUILT/pulldeck-bridge" "$BIN_DIR/pulldeck-bridge"

if [ -f ../icons/icon128.png ]; then
  cp ../icons/icon128.png "$RES_DIR/icon.png"
fi

# Where the extension lives, so the app can reveal it in Finder during setup.
# It has no other way to know where this repo was cloned.
EXTENSION_PATH="$(cd .. && pwd)"

python3 tools/write-plist.py "$APP/Contents/Info.plist" "$EXTENSION_PATH"
plutil -lint "$APP/Contents/Info.plist"

# Ad-hoc signature. Enough for a locally built app; Developer ID and
# notarization would only matter for distributing it to someone else.
echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo
echo "Built: $(cd "$APP" && pwd)"
echo
echo "Next: open \"$APP\""
echo "It installs the bridge itself, into whichever browsers have the extension"
echo "loaded. Nothing else to run."
