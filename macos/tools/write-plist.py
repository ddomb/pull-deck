#!/usr/bin/env python3
"""Serialize bundle metadata; checkout paths are data, including XML characters."""
import json
import plistlib
import sys
from pathlib import Path


def metadata(extension_path: str, version: str) -> dict:
    return {
        "CFBundleName": "Pull Deck", "CFBundleDisplayName": "Pull Deck",
        "CFBundleIdentifier": "com.pulldeck.app", "CFBundleExecutable": "PullDeckApp",
        "CFBundlePackageType": "APPL", "CFBundleVersion": version,
        "CFBundleShortVersionString": version, "LSMinimumSystemVersion": "13.0",
        "LSUIElement": True, "NSHighResolutionCapable": True,
        "PDExtensionPath": extension_path,
    }


if __name__ == "__main__":
    output, root = map(Path, sys.argv[1:3])
    version = json.loads((root / "manifest.json").read_text())["version"]
    with output.open("wb") as stream:
        plistlib.dump(metadata(str(root.resolve()), version), stream)
