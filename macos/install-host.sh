#!/bin/bash
# Installs the native messaging host manifest.
#
# You usually do not need this. Pull Deck.app installs the manifest itself, into
# whichever browsers actually have the extension loaded, and re-checks every few
# seconds while it is not connected. This script exists for scripted setups and
# for confirming from a terminal what the app would do.
#
#   ./install-host.sh              install where the extension is loaded
#   ./install-host.sh --uninstall  remove it everywhere
set -euo pipefail

cd "$(dirname "$0")"

APP="build/Pull Deck.app"
RELAY="$APP/Contents/MacOS/pulldeck-bridge"

if [ ! -x "$RELAY" ]; then
  echo "Relay not found at $RELAY" >&2
  echo "Run ./build-app.sh first." >&2
  exit 1
fi

# The relay shares the app's installer, so the terminal and the GUI can never
# disagree about where the manifest goes or what is in it.
case "${1:-}" in
  --uninstall) exec "$RELAY" --uninstall-hosts ;;
  "")          exec "$RELAY" --install-hosts ;;
  *)
    echo "Usage: ./install-host.sh [--uninstall]" >&2
    echo >&2
    echo "The extension id is pinned by the \"key\" field in manifest.json and no" >&2
    echo "longer depends on where this repo lives, so there is nothing to pass." >&2
    exit 1
    ;;
esac
