"""
Push a model bundle to the server: `python -m brain.push <bundle_dir>` (or `--social` for the private social model).

The bundle is checked here first (manifest.json, every file in `manifest.sha256` present with a matching hash), then
tarred, copied with scp into `<SERVER_BRAIN_DIR>/staging/` and installed over ssh by one bash script: extract to
`models/<version>/`, check every hash again on the server, chown to godseye, point `current` at it atomically (a temp
symlink renamed over the old one), keep the old target as `previous`, and prune `models/` to the newest few versions.
A social bundle goes the same way under `<SERVER_BRAIN_DIR>/social/`, and its files are also linked at the paths
CONTRACT.md gives the runtime (`social/manifest.json`, `social/social.onnx`) through `current`, so both switch with it.
`--explore-only` (the gate's exit 3, CONTRACT.md "Promotion") ships the bundle with `brain_enabled: false` in its
manifest, and only while the server's live model isn't a promoted one: it reads `current/manifest.json` first and
refuses if `brain_enabled` is true (or absent), and the install script checks again before it switches `current`.
A version already on the server is reused when its networks match; a manifest.json that differs (brain_enabled, after
an explore-only push of the same version) is replaced, so that version can still be promoted.
Nothing here reads or prints a secret.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from brain import config

KEEP = 5  # model versions kept on the server (the current and previous ones are never pruned)
OWNER = "godseye:godseye"

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")  # a version or a file name: no slashes, no leading dot
SAFE_DIR = re.compile(r"^/[A-Za-z0-9._/-]+$")  # the server's brain dir: absolute, nothing a shell would expand
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SOCIAL_MODEL = "social.onnx"  # the social network's file name, fixed by CONTRACT.md (Social score)

Run = Callable[..., subprocess.CompletedProcess]
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"]  # never hang a launchd cycle on a prompt
PROMOTED_LIVE = 4  # the install script's exit code when an explore-only bundle meets a promoted live model


class BundleError(Exception):
    """The bundle can't be pushed: what's wrong, in one line."""


class PromotedModelLive(Exception):
    """An explore-only bundle never replaces a promoted model: the server keeps it."""


@dataclass(frozen=True)
class Bundle:
    """A checked bundle: its version and the hash of every file to ship (manifest.json included)."""

    dir: Path
    version: str
    files: dict[str, str]  # name -> sha256

    @property
    def size(self) -> int:
        return sum((self.dir / n).stat().st_size for n in self.files)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def referenced_files(manifest: dict) -> list[str]:
    """The files the runtime will open: the entry ensemble members, the exit network and a social bundle's `file`."""
    out: list[str] = []
    entry, exit_ = manifest.get("entry"), manifest.get("exit")
    if isinstance(entry, dict):
        out += [m for m in entry.get("members", []) if isinstance(m, str)]
    if isinstance(exit_, dict) and isinstance(exit_.get("file"), str):
        out.append(exit_["file"])
    if isinstance(manifest.get("file"), str):
        out.append(manifest["file"])
    return out


def validate_bundle(bundle_dir: Path, social: bool = False) -> Bundle:
    """Check a bundle before it leaves the Mac. Raises BundleError on the first problem."""
    bundle_dir = Path(bundle_dir)
    mpath = bundle_dir / "manifest.json"
    if not mpath.is_file():
        raise BundleError(f"no manifest.json in {bundle_dir}")
    try:
        manifest = json.loads(mpath.read_text())
    except (OSError, ValueError) as e:
        raise BundleError(f"manifest.json unreadable: {e}") from e
    if not isinstance(manifest, dict):
        raise BundleError("manifest.json is not an object")

    version = manifest.get("version")
    if not isinstance(version, str) or not SAFE_NAME.match(version):
        raise BundleError(f"manifest version missing or unsafe: {version!r}")
    # A model bundle has an entry network; a social one doesn't. Catches a bundle pushed to the wrong place.
    if social and "entry" in manifest:
        raise BundleError("this is a model bundle, not a social one (drop --social)")
    if not social and not isinstance(manifest.get("entry"), dict):
        raise BundleError("no entry network in the manifest (a social bundle needs --social)")

    hashes = manifest.get("sha256")
    if not isinstance(hashes, dict) or not hashes:
        raise BundleError("manifest has no sha256 list")
    files: dict[str, str] = {}
    for name, digest in hashes.items():
        if not isinstance(name, str) or not SAFE_NAME.match(name) or name == "manifest.json":
            raise BundleError(f"unsafe file name in sha256: {name!r}")
        if not isinstance(digest, str) or not SHA256.match(digest.lower()):
            raise BundleError(f"bad sha256 for {name}")
        p = bundle_dir / name
        if not p.is_file():
            raise BundleError(f"{name} is listed but missing")
        if sha256_file(p) != digest.lower():
            raise BundleError(f"{name} doesn't match its sha256")
        files[name] = digest.lower()
    for name in referenced_files(manifest):
        if name not in files:
            raise BundleError(f"{name} is used by the manifest but has no sha256")
    if social and SOCIAL_MODEL not in files:
        raise BundleError(f"a social bundle must ship {SOCIAL_MODEL} (the runtime reads that name)")

    files["manifest.json"] = sha256_file(mpath)
    return Bundle(bundle_dir, version, files)


def make_tarball(bundle: Bundle, out: Path) -> Path:
    """Tar (gzip) just the checked files under `<version>/`, so strays in the bundle dir never ship."""
    with tarfile.open(out, "w:gz") as tar:
        for name in sorted(bundle.files):
            tar.add(bundle.dir / name, arcname=f"{bundle.version}/{name}", recursive=False)
    return out


def explore_only_copy(bundle: Bundle, out_dir: Path) -> Bundle:
    """A copy of the bundle in `out_dir` with `brain_enabled: false` in its manifest; the original is left alone.
    Nothing else changes: manifest.json isn't in `sha256`, so the networks' hashes still hold."""
    manifest = json.loads((bundle.dir / "manifest.json").read_text())
    manifest["brain_enabled"] = False
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in bundle.files:
        if name != "manifest.json":
            shutil.copyfile(bundle.dir / name, out_dir / name)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return validate_bundle(out_dir)


def brain_enabled(manifest: object) -> bool:
    """Does this manifest let the Brain account trade? A manifest without the flag predates explore-only pushes, so
    only a gate-passing bundle could have put it there: it counts as promoted."""
    return not (isinstance(manifest, dict) and manifest.get("brain_enabled") is False)


def live_manifest(host: str, base: str, run: Run) -> dict | None:
    """The server's `current/manifest.json`, or None when no model is installed yet. A `current` that is there but
    unreadable fails the ssh (and so the push) rather than reading as "no model"."""
    q = shlex.quote
    cmd = f"cd {q(base)} 2>/dev/null || exit 0; [ -e current ] || [ -L current ] || exit 0; cat current/manifest.json"
    out = run(["ssh", *SSH_OPTS, host, cmd], check=True, capture_output=True, text=True).stdout or ""
    if not out.strip():
        return None
    try:
        manifest = json.loads(out)
    except ValueError as e:
        raise BundleError(f"the server's current manifest.json is unreadable: {e}") from e
    if not isinstance(manifest, dict):
        raise BundleError("the server's current manifest.json is not an object")
    return manifest


def remote_base(social: bool, server_dir: str | None = None) -> str:
    base = server_dir or config.SERVER_BRAIN_DIR
    if not SAFE_DIR.match(base) or ".." in base.split("/"):
        raise BundleError(f"unsafe server brain dir: {base!r}")
    base = base.rstrip("/")
    return f"{base}/social" if social else base


def tar_name(version: str) -> str:
    return f"{version}.tar.gz"


def stable_links(bundle: Bundle, owner: str = OWNER) -> str:
    """Script lines that keep `<name> -> current/<name>` for every file of a social bundle (the paths CONTRACT.md
    gives the runtime), each swapped atomically, and drop such links left over from an older bundle."""
    q = shlex.quote
    lines = [f"ln -sfn {q('current/' + n)} {q(n + '.tmp')} && mv -Tf {q(n + '.tmp')} {q(n)} && chown -h {q(owner)} {q(n)}"
             for n in sorted(bundle.files)]
    names = " ".join(sorted(bundle.files))  # SAFE_NAME-checked: nothing to quote
    lines.append(f"""for l in *; do
  [ -L "$l" ] || continue
  case "$(readlink -- "$l")" in current/*) ;; *) continue ;; esac
  case " {names} " in *" $l "*) ;; *) rm -f -- "$l" ;; esac
done""")
    return "\n".join(lines) + "\n"


def explore_only_guard() -> str:
    """Script lines that stop an explore-only install (exit PROMOTED_LIVE) when the live manifest doesn't say
    `"brain_enabled": false`: the second check, right where `current` would switch."""
    return f"""if [ -e current/manifest.json ] && ! grep -Eq '"brain_enabled"[[:space:]]*:[[:space:]]*false' current/manifest.json; then
  echo "the live model is promoted (brain_enabled true): an explore-only bundle doesn't replace it" >&2
  exit {PROMOTED_LIVE}
fi
"""


def remote_install_script(bundle: Bundle, base: str, keep: int = KEEP, owner: str = OWNER, social: bool = False,
                          explore_only: bool = False) -> str:
    """The bash script the server runs (fed on stdin to `bash -s`). Every path and name in it is shlex-quoted."""
    q = shlex.quote
    v = bundle.version
    target = f"models/{v}"
    sums = "\n".join(f"{bundle.files[n]}  {n}" for n in sorted(bundle.files))
    nets = "\n".join(f"{bundle.files[n]}  {n}" for n in sorted(bundle.files) if n != "manifest.json")
    links = stable_links(bundle, owner) if social else ""
    guard = explore_only_guard() if explore_only else ""
    return f"""set -euo pipefail
umask 022
cd {q(base)}
mkdir -p staging models
tarball=staging/{q(tar_name(v))}
trap 'rm -f -- "$tarball"' EXIT
{guard}work=$(mktemp -d staging/.install-XXXXXX)
trap 'rm -rf -- "$work" "$tarball"' EXIT
check() {{ (cd "$1" && sha256sum --check --strict --quiet <<'SUMS'
{sums}
SUMS
) }}
check_nets() {{ (cd "$1" && sha256sum --check --strict --quiet <<'SUMS'
{nets}
SUMS
) }}
tar -xzf "$tarball" -C "$work" --no-same-owner --no-same-permissions
if [ -e {q(target)} ]; then
  # Already here (a retried push, or the same version pushed again after an explore-only push): use it only if its
  # networks are this bundle's. Only manifest.json may differ (the explore-only flag): the new one is renamed over it,
  # and the runtime reloads on the manifest's mtime.
  check_nets {q(target)} || {{ echo "models/{v} is already on the server with different files" >&2; exit 3; }}
  if ! check {q(target)}; then
    check "$work"/{q(v)}
    mv -f -- "$work"/{q(v)}/manifest.json {q(target)}/manifest.json
  fi
else
  check "$work"/{q(v)}
  mv -T -- "$work"/{q(v)} {q(target)}
fi
chown -R {q(owner)} {q(target)}
chown {q(owner)} . staging models
old=$(readlink current 2>/dev/null || true)
ln -sfn {q(target)} current.tmp && mv -Tf current.tmp current
if [ -n "$old" ] && [ "$old" != {q(target)} ]; then
  ln -sfn "$old" previous.tmp && mv -Tf previous.tmp previous
fi
chown -h {q(owner)} current
[ -L previous ] && chown -h {q(owner)} previous
{links}cur=$(readlink current); prev=$(readlink previous 2>/dev/null || true)
find models -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort -r | tail -n +{keep + 1} | while IFS= read -r d; do
  [ "models/$d" = "$cur" ] || [ "models/$d" = "$prev" ] || rm -rf -- "models/$d"
done
echo "current -> $cur"
"""


def push(bundle_dir: Path, social: bool = False, run: Run = subprocess.run, server: str | None = None,
         server_dir: str | None = None, keep: int = KEEP, explore_only: bool = False) -> Bundle:
    """Validate, copy and install a bundle on the server. `run` is subprocess.run (swapped out in tests).
    `explore_only` ships it with `brain_enabled: false`, and raises PromotedModelLive (pushing nothing) when the
    server's live model is a promoted one."""
    if explore_only and social:
        raise BundleError("--explore-only is for the model bundle, not the social one")
    bundle = validate_bundle(bundle_dir, social)
    host = server or config.SERVER
    base = remote_base(social, server_dir)
    if explore_only:
        live = live_manifest(host, base, run)
        if live is not None and brain_enabled(live):
            raise PromotedModelLive("the server runs a promoted model (brain_enabled true): it keeps it")
    with tempfile.TemporaryDirectory() as tmp:
        shipped = explore_only_copy(bundle, Path(tmp) / "bundle") if explore_only else bundle
        tarball = make_tarball(shipped, Path(tmp) / tar_name(bundle.version))
        run(["ssh", *SSH_OPTS, host, f"mkdir -p {shlex.quote(base + '/staging')}"], check=True)
        # scp's remote path isn't shell-quoted (newer scp doesn't go through a shell): it's checked safe above.
        run(["scp", "-q", *SSH_OPTS, str(tarball), f"{host}:{base}/staging/{tar_name(bundle.version)}"], check=True)
        script = remote_install_script(shipped, base, keep, social=social, explore_only=explore_only)
        try:
            run(["ssh", *SSH_OPTS, host, "bash -s"], input=script, text=True, check=True)
        except subprocess.CalledProcessError as e:
            if explore_only and e.returncode == PROMOTED_LIVE:
                raise PromotedModelLive("a promoted model went live on the server meanwhile: it keeps it") from e
            raise
    return bundle


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bundle_dir", type=Path)
    ap.add_argument("--social", action="store_true", help="a social bundle: goes to <server brain dir>/social/")
    ap.add_argument("--check", action="store_true", help="only validate the bundle, push nothing")
    ap.add_argument("--explore-only", action="store_true",
                    help=f"gate exit 3: push with brain_enabled false, only while the server has no promoted model "
                         f"(exit {PROMOTED_LIVE} when it has one)")
    args = ap.parse_args(argv)
    kind = "social" if args.social else "explore-only model" if args.explore_only else "model"
    try:
        if args.explore_only and args.social:
            raise BundleError("--explore-only is for the model bundle, not the social one")
        if args.check:
            b = validate_bundle(args.bundle_dir, args.social)
            print(f"{kind} bundle {b.version}: {len(b.files)} files, {b.size / 1e6:.1f} MB, ok")
            return 0
        b = push(args.bundle_dir, args.social, explore_only=args.explore_only)
    except BundleError as e:
        print(f"push refused: {e}", file=sys.stderr)
        return 2
    except PromotedModelLive as e:
        print(f"push skipped: {e}", file=sys.stderr)
        return PROMOTED_LIVE
    except subprocess.CalledProcessError as e:
        print(f"push failed: {e.cmd[0]} exited {e.returncode}", file=sys.stderr)
        return 1
    print(f"pushed {kind} bundle {b.version} ({len(b.files)} files, {b.size / 1e6:.1f} MB) to {config.SERVER}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
