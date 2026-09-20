#!/usr/bin/env bash
# Patches required for nodejs-mobile on Android (no ICU, flaky nested asset extract).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEST="$ROOT/mobile/android/app/src/main/assets/nodejs-project"
export ASSETS="$ROOT/mobile/android/app/src/main/assets"

python3 <<'PY'
from pathlib import Path
import os

dest = Path(os.environ["DEST"])
assets = Path(os.environ["ASSETS"])

# --- path-to-regexp: strip Unicode property escapes (no ICU) ---
ptr = dest / "node_modules/path-to-regexp/dist/index.js"
if ptr.exists():
    c = ptr.read_text(encoding="utf-8")
    c2 = c
    c2 = c2.replace(r"const ID_START = /^[$_\p{ID_Start}]$/u;", "const ID_START = /^[$_A-Za-z]$/;")
    c2 = c2.replace(r"const ID_CONTINUE = /^[$\u200c\u200d\p{ID_Continue}]$/u;", "const ID_CONTINUE = /^[$_A-Za-z0-9]$/;")
    c2 = c2.replace(r"const ID = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;", "const ID = /^[$_A-Za-z][$_A-Za-z0-9]*$/;")
    if c2 != c:
        ptr.write_text(c2, encoding="utf-8")
        print("patched path-to-regexp")

# --- iconv-lite: inline mergeModules (helpers/ often missing on device) ---
INLINE = """function mergeModules (target, module) {
  var hasOwn = Object.prototype.hasOwnProperty
  for (var key in module) {
    if (hasOwn.call(module, key)) {
      target[key] = module[key]
    }
  }
}
"""
for rel in (
    "node_modules/iconv-lite/lib/index.js",
    "node_modules/iconv-lite/encodings/index.js",
):
    p = dest / rel
    if not p.exists():
        continue
    c = p.read_text(encoding="utf-8")
    if "helpers/merge-exports" not in c:
        print("already patched", rel)
        continue
    c2 = c.replace('var mergeModules = require("./helpers/merge-exports")\n', INLINE)
    c2 = c2.replace('var mergeModules = require("../lib/helpers/merge-exports")\n', INLINE)
    if c2 != c:
        p.write_text(c2, encoding="utf-8")
        print("patched", rel)

# --- regenerate asset lists ---
dirs = ["nodejs-project"]
files = []
for p in sorted(dest.rglob("*")):
    if p.name == ".DS_Store":
        continue
    if "node_modules/.bin" in p.as_posix():
        continue
    rel = p.relative_to(assets).as_posix()
    if p.is_dir():
        dirs.append(rel)
    elif p.is_file():
        files.append(rel)
(assets / "dir.list").write_text("\n".join(dirs) + "\n", encoding="ascii")
(assets / "file.list").write_text("\n".join(files) + "\n", encoding="ascii")
print(f"lists: {len(dirs)} dirs, {len(files)} files")
PY
