#!/usr/bin/env python3
"""Prépare et, avec --publish, envoie la release GitHub.

Reprend l’APK de la release précédente, remplace public/ et la version,
signe avec le même certificat, puis publie GamelleChat-<version>.apk.
Ne touche pas à ACCOUNTS_RESET_ID.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = "ShivaneUN/gamelle-chat"
CERT_SHA = "4ff276a141fb3508e842156a87047230312c92ee04a8fb4b67a9c32d95f6805f"
SIGNER_URL = "https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar"
KEY_PROPS = ROOT / "mobile/android/key.properties"
KEYSTORE = ROOT / "mobile/android/app/gamelle-release.jks"
PUBLIC = ROOT / "public"
ASSETS_NODE = ROOT / "mobile/android/app/src/main/assets/nodejs-project"
INT_DEC = 0x10


def run(cmd, **kwargs):
    return subprocess.run(cmd, check=True, **kwargs)


def read_props(path: Path) -> dict:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def semver(text: str):
    parts = str(text or "").strip().lstrip("vV").split(".")
    nums = []
    for p in parts[:3]:
        n = ""
        for ch in p:
            if ch.isdigit():
                n += ch
            else:
                break
        if not n:
            return None
        nums.append(int(n))
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def semver_str(ver) -> str:
    return ".".join(str(n) for n in ver)


def bump_patch(ver):
    return (ver[0], ver[1], ver[2] + 1)


def latest_release_tag() -> str:
    res = subprocess.run(
        ["gh", "release", "view", "--repo", REPO, "--json", "tagName"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(res.stdout)["tagName"].strip()


def package_version() -> str:
    data = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return str(data["version"]).strip()


def replace_version_near_top(path: Path, old: str, new: str, limit: int = 20) -> None:
    lines = path.read_text(encoding="utf-8").splitlines(True)
    found = 0
    for i, line in enumerate(lines[:limit]):
        if old in line and "version" in line:
            lines[i] = line.replace(old, new, 1)
            found += 1
    if found < 1:
        raise SystemExit(f"version {old} introuvable dans {path}")
    path.write_text("".join(lines), encoding="utf-8")


def write_repo_version(version: str, version_code: int) -> None:
    old = package_version()
    if old == version:
        pub = ROOT / "mobile/pubspec.yaml"
        text = pub.read_text(encoding="utf-8")
        needle = f"version: {version}+"
        if needle not in text:
            # Le nom est déjà bon ; on aligne seulement le versionCode.
            import re
            text2, n = re.subn(
                r"^version:\s*" + re.escape(version) + r"\+\d+\s*$",
                f"version: {version}+{version_code}",
                text,
                count=1,
                flags=re.M,
            )
            if n != 1:
                raise SystemExit("pubspec.yaml : versionCode non aligné")
            pub.write_text(text2, encoding="utf-8")
        return
    replace_version_near_top(ROOT / "package.json", old, version)
    replace_version_near_top(ROOT / "package-lock.json", old, version)
    replace_version_near_top(ASSETS_NODE / "package.json", old, version)
    replace_version_near_top(ASSETS_NODE / "package-lock.json", old, version)
    pub = ROOT / "mobile/pubspec.yaml"
    text = pub.read_text(encoding="utf-8")
    import re
    text2, n = re.subn(
        r"^version:\s*" + re.escape(old) + r"\+\d+\s*$",
        f"version: {version}+{version_code}",
        text,
        count=1,
        flags=re.M,
    )
    if n != 1:
        raise SystemExit("pubspec.yaml : ligne version introuvable")
    pub.write_text(text2, encoding="utf-8")


def u16(data, off):
    return struct.unpack_from("<H", data, off)[0]


def u32(data, off):
    return struct.unpack_from("<I", data, off)[0]


def decode_pool(data: bytes):
    if u16(data, 0) != 0x0003:
        raise SystemExit("AndroidManifest : en-tête inattendu")
    pool = u16(data, 2)  # header size of the file chunk, pool starts here
    if u16(data, pool) != 0x0001:
        raise SystemExit("AndroidManifest : table de chaînes introuvable")
    string_count = u32(data, pool + 8)
    flags = u32(data, pool + 16)
    strings_start = u32(data, pool + 20)
    utf8 = bool(flags & (1 << 8))
    offsets = [u32(data, pool + 28 + 4 * i) for i in range(string_count)]
    base = pool + strings_start
    strings = []
    spans = []
    for rel in offsets:
        at = base + rel
        if utf8:
            raise SystemExit("AndroidManifest UTF-8 non géré")
        nchars = u16(data, at)
        start = at + 2
        raw = data[start:start + nchars * 2]
        text = raw.decode("utf-16le")
        strings.append(text)
        spans.append((start, nchars))
    return strings, spans


def find_version_fields(data: bytearray):
    strings, spans = decode_pool(data)
    try:
        name_id = strings.index("versionName")
        code_id = strings.index("versionCode")
    except ValueError:
        raise SystemExit("versionName / versionCode absents du manifeste")
    version_name = None
    name_span = None
    for text, span in zip(strings, spans):
        parts = semver(text)
        if parts and text == semver_str(parts) and text.count(".") == 2:
            version_name = text
            name_span = span
            break
    if not version_name:
        raise SystemExit("versionName illisible dans le manifeste")

    version_code = None
    code_off = None
    off = u16(data, 2)
    size = u32(data, 4)
    while off + 8 <= size:
        typ = u16(data, off)
        chunk = u32(data, off + 4)
        if chunk < 8 or off + chunk > size:
            break
        if typ == 0x0102:
            ext = off + 16
            attr_start = u16(data, ext + 8)
            attr_size = u16(data, ext + 10)
            attr_count = u16(data, ext + 12)
            for i in range(attr_count):
                a = ext + attr_start + i * attr_size
                if a + 20 > size:
                    break
                attr_name = u32(data, a + 4)
                data_type = data[a + 15]
                data_off = a + 16
                if attr_name == code_id and data_type == INT_DEC:
                    version_code = u32(data, data_off)
                    code_off = data_off
                if attr_name == name_id and data_type == 0x03:
                    pass
        off += chunk
    if version_code is None or code_off is None:
        raise SystemExit("versionCode illisible dans le manifeste")
    return version_name, name_span, version_code, code_off


def patch_manifest(data: bytearray, new_version: str, new_code: int) -> bytearray:
    old_version, span, old_code, code_off = find_version_fields(data)
    if len(new_version) != len(old_version):
        raise SystemExit(
            f"La version {new_version} n’a pas la même longueur que {old_version}. "
            "Garde un numéro du type 0.2.xx."
        )
    start, nchars = span
    encoded = new_version.encode("utf-16le")
    if len(encoded) != nchars * 2:
        raise SystemExit("encodage versionName inattendu")
    data[start:start + len(encoded)] = encoded
    struct.pack_into("<I", data, code_off, new_code)
    check_name, _, check_code, _ = find_version_fields(data)
    if check_name != new_version or check_code != new_code:
        raise SystemExit(f"manifeste non mis à jour ({check_name}+{check_code})")
    return data


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1000:
        return
    urllib.request.urlretrieve(url, dest)


def signer_jar() -> Path:
    dest = Path("/tmp/apktools/uber-apk-signer.jar")
    if not dest.exists():
        download(SIGNER_URL, dest)
    return dest


def download_base_apk(tag: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 1_000_000:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    run([
        "gh", "release", "download", tag,
        "--repo", REPO,
        "--pattern", "*.apk",
        "--output", str(dest),
        "--clobber",
    ])


def stage_public(stage: Path) -> None:
    public_root = stage / "assets/nodejs-project/public"
    if public_root.exists():
        shutil.rmtree(public_root)
    shutil.copytree(PUBLIC, public_root)
    server_dest = stage / "assets/nodejs-project/server.js"
    server_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "server.js", server_dest)


def build_apk(base_apk: Path, version: str, version_code: int, out_apk: Path) -> None:
    work = Path(tempfile.mkdtemp(prefix="gamelle-rel-"))
    unsigned = work / "unsigned.apk"
    shutil.copyfile(base_apk, unsigned)
    with zipfile.ZipFile(base_apk) as z:
        manifest = bytearray(z.read("AndroidManifest.xml"))
    manifest = patch_manifest(manifest, version, version_code)
    stage = work / "stage"
    stage.mkdir()
    (stage / "AndroidManifest.xml").write_bytes(manifest)
    stage_public(stage)
    pkg = json.loads((ASSETS_NODE / "package.json").read_text(encoding="utf-8"))
    pkg["version"] = version
    pkg_path = stage / "assets/nodejs-project/package.json"
    pkg_path.parent.mkdir(parents=True, exist_ok=True)
    pkg_path.write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8")
    names = ["AndroidManifest.xml", "assets/nodejs-project/package.json", "assets/nodejs-project/server.js"]
    for p in (stage / "assets/nodejs-project/public").rglob("*"):
        if p.is_file():
            names.append(p.relative_to(stage).as_posix())
    run(["zip", "-q", "-u", str(unsigned), *names], cwd=stage)
    run(["zip", "-q", "-d", str(unsigned), "META-INF/*.SF", "META-INF/*.RSA", "META-INF/MANIFEST.MF"])
    props = read_props(KEY_PROPS)
    signed_dir = work / "signed"
    run([
        "java", "-jar", str(signer_jar()),
        "-a", str(unsigned),
        "--ks", str(KEYSTORE),
        "--ksAlias", props.get("keyAlias", "gamelle"),
        "--ksPass", props["storePassword"],
        "--ksKeyPass", props.get("keyPassword", props["storePassword"]),
        "--allowResign",
        "--verifySha256", CERT_SHA,
        "-o", str(signed_dir),
    ])
    signed = next(signed_dir.glob("*.apk"))
    out_apk.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(signed, out_apk)
    verify_apk(base_apk, out_apk, version, version_code)
    shutil.rmtree(work, ignore_errors=True)


def verify_apk(base_apk: Path, new_apk: Path, version: str, version_code: int) -> None:
    with zipfile.ZipFile(new_apk) as z:
        manifest = bytearray(z.read("AndroidManifest.xml"))
        js = z.read("assets/nodejs-project/public/talk-pcm.js")
        pkg = z.read("assets/nodejs-project/package.json")
    name, _, code, _ = find_version_fields(manifest)
    if name != version or code != version_code:
        raise SystemExit(f"APK version {name}+{code}, attendu {version}+{version_code}")
    if f'"version": "{version}"'.encode() not in pkg:
        raise SystemExit("package.json de l’APK n’a pas la nouvelle version")
    if b"cleanIncomingEcho" not in js and (PUBLIC / "talk-pcm.js").read_bytes().find(b"cleanIncomingEcho") >= 0:
        raise SystemExit("talk-pcm.js de l’APK n’est pas à jour")
    with zipfile.ZipFile(new_apk) as z:
        packed_server = z.read("assets/nodejs-project/server.js")
    if b"request-link" not in packed_server and (ROOT / "server.js").read_bytes().find(b"request-link") >= 0:
        raise SystemExit("server.js de l’APK n’est pas à jour")
    if b"ACCOUNTS_RESET_ID = '0.1.29'" not in packed_server:
        raise SystemExit("ACCOUNTS_RESET_ID a changé")
    with zipfile.ZipFile(base_apk) as old, zipfile.ZipFile(new_apk) as new:
        libs = [i.filename for i in old.infolist() if i.filename.startswith("lib/") and i.filename.endswith(".so")]
        for name_lib in libs:
            a = old.getinfo(name_lib)
            b = new.getinfo(name_lib)
            if a.CRC != b.CRC or a.file_size != b.file_size:
                raise SystemExit(f"librairie native modifiée : {name_lib}")
    run(["bash", str(ROOT / "tools/check-no-private-secrets.sh"), str(new_apk)])


VERSION_FILES = [
    ROOT / "package.json",
    ROOT / "package-lock.json",
    ROOT / "mobile/pubspec.yaml",
    ASSETS_NODE / "package.json",
    ASSETS_NODE / "package-lock.json",
]


def commit_version(version: str) -> None:
    rels = [str(p.relative_to(ROOT)) for p in VERSION_FILES]
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", *rels],
        check=True, capture_output=True, text=True, cwd=ROOT,
    ).stdout.strip()
    if not status:
        return
    run(["git", "add", "--", *rels], cwd=ROOT)
    run(["git", "commit", "-m", f"Version {version}."], cwd=ROOT)


def publish(apk: Path, version: str, notes: str) -> None:
    commit_version(version)
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        check=True, capture_output=True, text=True, cwd=ROOT,
    ).stdout.strip()
    run(["git", "push", "-u", "origin", branch], cwd=ROOT)
    run([
        "gh", "release", "create", version, str(apk),
        "--repo", REPO,
        "--target", branch,
        "--title", version,
        "--notes", notes,
    ], cwd=ROOT)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prépare ou publie la release GitHub Gamelle Chat.")
    parser.add_argument("--publish", action="store_true", help="Crée la release GitHub. Sans ce drapeau, l’APK est seulement construit.")
    parser.add_argument("--version", help="Version à écrire (défaut : package.json, ou le patch suivant si déjà publié).")
    parser.add_argument("--write-version", action="store_true", help="Écrit la version dans le dépôt si elle change.")
    parser.add_argument("--base-apk", help="APK de départ. Défaut : dernière release GitHub.")
    parser.add_argument("--notes", default="Mise à jour Gamelle Chat.")
    parser.add_argument("--out", help="Chemin de l’APK signé.")
    args = parser.parse_args()

    latest = latest_release_tag()
    latest_ver = semver(latest)
    if not latest_ver:
        raise SystemExit(f"release courante illisible : {latest}")
    chosen = semver(args.version) if args.version else semver(package_version())
    if not chosen:
        raise SystemExit("version du dépôt illisible")
    if chosen <= latest_ver:
        chosen = bump_patch(latest_ver)
        print(f"Version déjà publiée ({semver_str(latest_ver)}). Prochaine : {semver_str(chosen)}")
    version = semver_str(chosen)

    base = Path(args.base_apk) if args.base_apk else Path(tempfile.gettempdir()) / f"GamelleChat-{semver_str(latest_ver)}-base.apk"
    if not args.base_apk:
        download_base_apk(latest, base)
    with zipfile.ZipFile(base) as z:
        manifest = bytearray(z.read("AndroidManifest.xml"))
    _, _, old_code, _ = find_version_fields(manifest)
    version_code = old_code + 1
    print(f"APK {version}+{version_code} à partir de {base.name} ({old_code})")

    if args.write_version or args.publish:
        write_repo_version(version, version_code)
        print(f"Version écrite dans le dépôt : {version}+{version_code}")

    out = Path(args.out) if args.out else Path(tempfile.gettempdir()) / f"GamelleChat-{version}.apk"
    build_apk(base, version, version_code, out)
    print(f"APK signé : {out}")
    if args.publish:
        publish(out, version, args.notes)
        print(f"Release publiée : https://github.com/{REPO}/releases/tag/{version}")
    else:
        print("Pas de publication. Ajoute --publish pour envoyer sur GitHub.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as exc:
        print(exc, file=sys.stderr)
        sys.exit(exc.returncode or 1)
