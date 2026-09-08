#!/usr/bin/env python3
"""Package only the runtime allowlist, never the checkout or local test data."""
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "manifest.json").read_text())["version"]
output = root / "dist" / f"pull-deck-{version}.zip"
output.parent.mkdir(exist_ok=True)
files = [root / "manifest.json", root / "README.md"]
for folder in ["src", "icons", "rules"]:
    files += [p for p in (root / folder).iterdir() if p.is_file()]
if (root / "LICENSE").exists():
    files.append(root / "LICENSE")
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(files):
        info = zipfile.ZipInfo(str(path.relative_to(root)), (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())
print(output)
