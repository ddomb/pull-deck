#!/bin/bash
# Registers the relay as a Chrome native messaging host.
#
# Chrome will only launch a host that is declared in a manifest at a specific
# path, and will only let the extension IDs listed in allowed_origins talk to
# it. That allow-list is the security boundary — nothing else can reach the
# menu bar app's socket through this route.
set -euo pipefail

cd "$(dirname "$0")"

HOST_NAME="com.pulldeck.bridge"
EXTENSION_ID="${1:-}"
BROWSER="${2:-chrome}"

if [ -z "$EXTENSION_ID" ]; then
  cat <<'USAGE'
Usage: ./install-host.sh <extension-id> [chrome|edge]

Find the extension id at chrome://extensions with Developer mode on — it is the
32-letter string under "Pull Deck".
USAGE
  exit 1
fi

if ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "That does not look like a Chrome extension id (32 letters a-p): $EXTENSION_ID" >&2
  exit 1
fi

# Verified against Chrome's native messaging documentation.
case "$BROWSER" in
  chrome) TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  edge)   TARGET_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
  *) echo "Unknown browser '$BROWSER'. Use chrome or edge." >&2; exit 1 ;;
esac

RELAY="$(cd "$(dirname "build/Pull Deck.app")" && pwd)/Pull Deck.app/Contents/MacOS/pulldeck-bridge"

if [ ! -x "$RELAY" ]; then
  echo "Relay not found at:" >&2
  echo "  $RELAY" >&2
  echo "Run ./build-app.sh first." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
MANIFEST="$TARGET_DIR/$HOST_NAME.json"

# `path` must be absolute on macOS. `type` has exactly one legal value.
cat > "$MANIFEST" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Pull Deck bridge between the Chrome extension and the macOS menu bar app",
  "path": "$RELAY",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
JSON

echo "Installed $MANIFEST"
echo
echo "  host      $HOST_NAME"
echo "  relay     $RELAY"
echo "  extension $EXTENSION_ID"
echo
echo "Now: open \"build/Pull Deck.app\", then reload the extension at chrome://extensions."
echo "The extension reconnects on its own — within 30 seconds if it had already given up."
