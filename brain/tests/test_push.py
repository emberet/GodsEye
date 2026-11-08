"""
brain.push: bundle validation, the tarball, the ssh/scp commands and the server-side install script.
No real ssh: subprocess.run is replaced, and the install script runs locally under bash with small stand-ins for the
GNU tools it uses on the server (sha256sum --check, mv -T, find -printf, chown).
"""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from brain import push


def write_bundle(d: Path, version: str = "2026-11-07T12-00-00Z", social: bool = False, **over) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    if social:
        files = {"social.onnx": b"social-net"}
        manifest = {"version": version, "feature_spec_version": 1, "file": "social.onnx"}
    else:
        files = {f"entry-{i}.onnx": f"entry-{i}".encode() for i in range(2)} | {"exit.onnx": b"exit-net"}
        manifest = {
            "version": version,
            "feature_spec_version": 1,
            "entry": {"members": ["entry-0.onnx", "entry-1.onnx"], "features": ["a"]},
            "exit": {"file": "exit.onnx", "features": ["b"]},
        }
    for name, data in files.items():
        (d / name).write_bytes(data)
    manifest["sha256"] = {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}
    manifest.update(over)
    (d / "manifest.json").write_text(json.dumps(manifest))
    return d


# ---- validation ----


def test_valid_model_bundle(tmp_path):
    b = push.validate_bundle(write_bundle(tmp_path / "b"))
    assert b.version == "2026-11-07T12-00-00Z"
    assert set(b.files) == {"entry-0.onnx", "entry-1.onnx", "exit.onnx", "manifest.json"}
    assert b.files["manifest.json"] == push.sha256_file(tmp_path / "b" / "manifest.json")


def test_valid_social_bundle(tmp_path):
    b = push.validate_bundle(write_bundle(tmp_path / "s", social=True), social=True)
    assert set(b.files) == {"social.onnx", "manifest.json"}


@pytest.mark.parametrize(
    "mutate, msg",
    [
        (lambda d: (d / "manifest.json").unlink(), "no manifest.json"),
        (lambda d: (d / "manifest.json").write_text("{nope"), "unreadable"),
        (lambda d: (d / "exit.onnx").unlink(), "exit.onnx is listed but missing"),
        (lambda d: (d / "entry-1.onnx").write_bytes(b"tampered"), "entry-1.onnx doesn't match"),
    ],
)
def test_broken_bundles_are_refused(tmp_path, mutate, msg):
    d = write_bundle(tmp_path / "b")
    mutate(d)
    with pytest.raises(push.BundleError, match=msg):
        push.validate_bundle(d)


@pytest.mark.parametrize(
    "over, msg",
    [
        ({"version": "../etc"}, "version missing or unsafe"),
        ({"version": "v1; rm -rf /"}, "version missing or unsafe"),
        ({"version": None}, "version missing or unsafe"),
        ({"sha256": {}}, "no sha256 list"),
        ({"sha256": {"../x": "0" * 64}}, "unsafe file name"),
        ({"sha256": {"exit.onnx": "xyz"}}, "bad sha256"),
    ],
)
def test_unsafe_manifests_are_refused(tmp_path, over, msg):
    with pytest.raises(push.BundleError, match=msg):
        push.validate_bundle(write_bundle(tmp_path / "b", **over))


def test_file_used_by_manifest_must_be_hashed(tmp_path):
    d = write_bundle(tmp_path / "b")
    m = json.loads((d / "manifest.json").read_text())
    del m["sha256"]["exit.onnx"]
    (d / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(push.BundleError, match="exit.onnx is used by the manifest"):
        push.validate_bundle(d)


def test_model_and_social_bundles_cant_be_mixed_up(tmp_path):
    with pytest.raises(push.BundleError, match="drop --social"):
        push.validate_bundle(write_bundle(tmp_path / "m"), social=True)
    with pytest.raises(push.BundleError, match="needs --social"):
        push.validate_bundle(write_bundle(tmp_path / "s", social=True))


def test_tarball_holds_only_checked_files(tmp_path):
    d = write_bundle(tmp_path / "b")
    (d / "notes.txt").write_text("stray")
    b = push.validate_bundle(d)
    out = push.make_tarball(b, tmp_path / "b.tar.gz")
    with tarfile.open(out) as tar:
        names = sorted(tar.getnames())
    assert names == sorted(f"{b.version}/{n}" for n in b.files)


# ---- commands sent to the server ----


class FakeRun:
    """Records each subprocess.run call; checks the scp'd tarball while it still exists. `live` is what the server's
    current/manifest.json reads as ("" = no model installed)."""

    def __init__(self, live: str = ""):
        self.calls: list[tuple[list[str], dict]] = []
        self.tar_names: list[str] = []
        self.shipped_manifest: dict | None = None
        self.live = live

    def __call__(self, cmd, **kw):
        self.calls.append((list(cmd), kw))
        if cmd[0] == "scp":
            with tarfile.open(cmd[-2]) as tar:
                self.tar_names = sorted(tar.getnames())
                m = next(n for n in tar.getnames() if n.endswith("/manifest.json"))
                self.shipped_manifest = json.load(tar.extractfile(m))
        if cmd[0] == "ssh" and "cat current/manifest.json" in cmd[-1]:
            return subprocess.CompletedProcess(cmd, 0, self.live, "")
        return subprocess.CompletedProcess(cmd, 0, "", "")


def test_push_commands_model(tmp_path):
    run = FakeRun()
    b = push.push(write_bundle(tmp_path / "b"), run=run, server="GodsEye", server_dir="/opt/godseye/app/data/brain")
    (mk, mk_kw), (scp, _), (install, install_kw) = run.calls
    assert mk[0] == "ssh" and "BatchMode=yes" in mk and mk[-2] == "GodsEye"
    assert mk[-1] == "mkdir -p /opt/godseye/app/data/brain/staging"
    assert mk_kw["check"] is True
    assert scp[0] == "scp" and scp[-1] == f"GodsEye:/opt/godseye/app/data/brain/staging/{b.version}.tar.gz"
    assert run.tar_names == sorted(f"{b.version}/{n}" for n in b.files)
    assert install[-2:] == ["GodsEye", "bash -s"]
    script = install_kw["input"]
    assert "cd /opt/godseye/app/data/brain\n" in script
    assert f"{b.files['exit.onnx']}  exit.onnx" in script
    assert f"{b.files['manifest.json']}  manifest.json" in script
    assert "chown -R godseye:godseye models/2026-11-07T12-00-00Z" in script
    assert "ln -sfn models/2026-11-07T12-00-00Z current.tmp && mv -Tf current.tmp current" in script
    assert "tail -n +6" in script


def test_push_social_goes_under_social(tmp_path):
    run = FakeRun()
    push.push(write_bundle(tmp_path / "s", social=True), social=True, run=run, server="GodsEye",
              server_dir="/opt/godseye/app/data/brain/")
    (mk, _), (scp, _), (_, install_kw) = run.calls
    assert mk[-1] == "mkdir -p /opt/godseye/app/data/brain/social/staging"
    assert scp[-1].startswith("GodsEye:/opt/godseye/app/data/brain/social/staging/")
    assert "cd /opt/godseye/app/data/brain/social\n" in install_kw["input"]
    assert "ln -sfn current/social.onnx social.onnx.tmp && mv -Tf social.onnx.tmp social.onnx" in install_kw["input"]
    assert "ln -sfn current/manifest.json manifest.json.tmp" in install_kw["input"]


def test_invalid_bundle_never_touches_the_server(tmp_path):
    run = FakeRun()
    d = write_bundle(tmp_path / "b")
    (d / "exit.onnx").write_bytes(b"x")
    with pytest.raises(push.BundleError):
        push.push(d, run=run)
    assert run.calls == []


@pytest.mark.parametrize("bad", ["relative/dir", "/opt/$(reboot)", "/opt/a b", "/opt/../etc"])
def test_unsafe_server_dir_is_refused(tmp_path, bad):
    run = FakeRun()
    with pytest.raises(push.BundleError, match="unsafe server brain dir"):
        push.push(write_bundle(tmp_path / "b"), run=run, server_dir=bad)
    assert run.calls == []


def test_script_quotes_server_dir():
    b = push.Bundle(Path("."), "v1", {"manifest.json": "0" * 64})
    script = push.remote_install_script(b, "/srv/brain dir")
    assert f"cd {shlex.quote('/srv/brain dir')}" in script


def test_main_check_and_refusal(tmp_path, capsys):
    assert push.main([str(write_bundle(tmp_path / "b")), "--check"]) == 0
    assert "ok" in capsys.readouterr().out
    assert push.main([str(tmp_path / "missing"), "--check"]) == 2
    assert "push refused" in capsys.readouterr().err


# ---- the install script itself, run locally ----

SHIMS = {
    # sha256sum --check --strict --quiet: read "<hash>  <name>" lines from stdin.
    "sha256sum": """
import hashlib, sys
assert "--check" in sys.argv
bad = 0
for line in sys.stdin.read().splitlines():
    digest, name = line.split("  ", 1)
    try:
        ok = hashlib.sha256(open(name, "rb").read()).hexdigest() == digest
    except FileNotFoundError:
        ok = False
    if not ok:
        print(f"{name}: FAILED", file=sys.stderr); bad = 1
sys.exit(bad)
""",
    # mv -T / -Tf: replace the destination itself, never move into a directory it points at.
    "mv": """
import os, sys
args = [a for a in sys.argv[1:] if not a.startswith("-")]
src, dst = args
os.replace(src, dst)
""",
    # find <dir> -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'
    "find": """
import os, sys
d = sys.argv[1]
for n in os.listdir(d):
    if os.path.isdir(os.path.join(d, n)) and not os.path.islink(os.path.join(d, n)):
        print(n)
""",
    "chown": "",
}


@pytest.fixture
def server(tmp_path, monkeypatch):
    """A fake server: a brain dir plus a PATH with the GNU stand-ins. Returns a function that runs a push into it."""
    if not shutil.which("bash"):
        pytest.skip("no bash")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name, body in SHIMS.items():
        p = bindir / name
        p.write_text(f"#!{sys.executable}\n{body}")
        p.chmod(0o755)
    base = tmp_path / "srv" / "brain"
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}")

    def run(cmd, **kw):
        # Play the server: mkdir over "ssh", scp as a copy, the install script under local bash.
        if cmd[0] == "scp":
            dst = Path(cmd[-1].split(":", 1)[1])
            shutil.copyfile(cmd[-2], dst)
            return subprocess.CompletedProcess(cmd, 0)
        return subprocess.run(["bash", "-c", cmd[-1]], env=env, cwd=tmp_path, **kw)

    def do_push(bundle_dir: Path, social: bool = False, keep: int = 5, explore_only: bool = False):
        return push.push(bundle_dir, social=social, run=run, server="fake", server_dir=str(base), keep=keep,
                         explore_only=explore_only)

    do_push.base = base
    return do_push


def test_install_switches_current_keeps_previous_and_prunes(tmp_path, server):
    base = server.base
    versions = [f"2026-11-0{i}T00-00-00Z" for i in range(1, 8)]
    for v in versions:
        server(write_bundle(tmp_path / "bundles" / v, version=v), keep=5)
        assert os.readlink(base / "current") == f"models/{v}"
        assert (base / "current" / "manifest.json").is_file()
    assert os.readlink(base / "previous") == f"models/{versions[-2]}"
    assert sorted(os.listdir(base / "models")) == versions[-5:]
    assert [p for p in os.listdir(base / "staging") if not p.startswith(".")] == []  # tarball cleaned up
    assert not any(p.startswith(".install-") for p in os.listdir(base / "staging"))


def test_install_keeps_current_when_rolling_back_to_an_old_version(tmp_path, server):
    base = server.base
    for v in ["2026-11-03T00-00-00Z", "2026-11-04T00-00-00Z", "2026-11-05T00-00-00Z"]:
        server(write_bundle(tmp_path / "bundles" / v, version=v), keep=2)
    old = "2026-11-01T00-00-00Z"
    server(write_bundle(tmp_path / "bundles" / old, version=old), keep=2)
    assert os.readlink(base / "current") == f"models/{old}"
    # newest two by name, plus current (old) and previous (11-05); 11-04 is in the newest two
    assert sorted(os.listdir(base / "models")) == [old, "2026-11-04T00-00-00Z", "2026-11-05T00-00-00Z"]


def test_install_retry_is_idempotent_but_a_different_bundle_is_refused(tmp_path, server):
    v = "2026-11-07T12-00-00Z"
    d = write_bundle(tmp_path / "b", version=v)
    server(d)
    server(d)  # a retried push of the same bundle
    assert os.readlink(server.base / "current") == f"models/{v}"
    assert not (server.base / "previous").exists()
    d2 = write_bundle(tmp_path / "b2", version=v)
    (d2 / "exit.onnx").write_bytes(b"different")
    m = json.loads((d2 / "manifest.json").read_text())
    m["sha256"]["exit.onnx"] = hashlib.sha256(b"different").hexdigest()
    (d2 / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(subprocess.CalledProcessError) as e:
        server(d2)
    assert e.value.returncode == 3


def test_install_refuses_a_bundle_corrupted_in_transit(tmp_path, server, monkeypatch):
    real = push.make_tarball

    def corrupt(bundle, out):
        real(bundle, out)
        # rewrite the tarball with one file changed after validation
        tmpdir = tmp_path / "x"
        with tarfile.open(out) as tar:
            tar.extractall(tmpdir, filter="data")
        (tmpdir / bundle.version / "exit.onnx").write_bytes(b"flipped")
        with tarfile.open(out, "w:gz") as tar:
            tar.add(tmpdir / bundle.version, arcname=bundle.version)
        return out

    monkeypatch.setattr(push, "make_tarball", corrupt)
    with pytest.raises(subprocess.CalledProcessError):
        server(write_bundle(tmp_path / "b"))
    assert not (server.base / "current").exists()
    assert os.listdir(server.base / "models") == []


def test_social_install(tmp_path, server):
    v = "2026-11-07T12-00-00Z"
    server(write_bundle(tmp_path / "s", version=v, social=True), social=True)
    social = server.base / "social"
    assert os.readlink(social / "current") == f"models/{v}"
    assert (social / "current" / "social.onnx").read_bytes() == b"social-net"
    assert not (server.base / "current").exists()


def test_social_install_serves_the_contract_paths(tmp_path, server):
    """CONTRACT.md (Social score): the runtime reads data/brain/social/manifest.json and social.onnx."""
    social = server.base / "social"
    v1, v2 = "2026-11-07T12-00-00Z", "2026-11-07T13-00-00Z"
    d1 = write_bundle(tmp_path / "s1", version=v1, social=True)
    m1 = json.loads((d1 / "manifest.json").read_text())
    m1["sha256"]["calib.json"] = hashlib.sha256(b"{}").hexdigest()
    (d1 / "calib.json").write_bytes(b"{}")
    (d1 / "manifest.json").write_text(json.dumps(m1))
    server(d1, social=True)
    assert json.loads((social / "manifest.json").read_text())["version"] == v1
    assert (social / "social.onnx").read_bytes() == b"social-net"
    assert os.readlink(social / "social.onnx") == "current/social.onnx"  # switches with `current`
    assert (social / "calib.json").is_symlink()

    d2 = write_bundle(tmp_path / "s2", version=v2, social=True)
    (d2 / "social.onnx").write_bytes(b"social-net-2")
    m2 = json.loads((d2 / "manifest.json").read_text())
    m2["sha256"]["social.onnx"] = hashlib.sha256(b"social-net-2").hexdigest()
    (d2 / "manifest.json").write_text(json.dumps(m2))
    server(d2, social=True)
    assert json.loads((social / "manifest.json").read_text())["version"] == v2
    assert (social / "social.onnx").read_bytes() == b"social-net-2"
    assert not os.path.lexists(social / "calib.json")  # a file the new bundle dropped is unlinked
    assert not any(n.endswith(".tmp") for n in os.listdir(social))
    assert os.readlink(social / "previous") == f"models/{v1}"


def test_model_install_adds_no_contract_links(tmp_path, server):
    server(write_bundle(tmp_path / "b"))
    assert sorted(os.listdir(server.base)) == ["current", "models", "staging"]


def test_social_bundle_must_ship_social_onnx(tmp_path):
    d = tmp_path / "s"
    d.mkdir()
    (d / "net.onnx").write_bytes(b"x")
    (d / "manifest.json").write_text(json.dumps({
        "version": "v1", "file": "net.onnx", "sha256": {"net.onnx": hashlib.sha256(b"x").hexdigest()}}))
    with pytest.raises(push.BundleError, match="must ship social.onnx"):
        push.validate_bundle(d, social=True)


# ---- explore-only (gate exit 3, CONTRACT.md "Promotion") ----


def test_explore_only_ships_brain_enabled_false_and_changes_nothing_else(tmp_path):
    d = write_bundle(tmp_path / "b", brain_enabled=True, explore={"rate": 0.1, "curiosity": 0.5})
    before = (d / "manifest.json").read_bytes()
    run = FakeRun()
    b = push.push(d, run=run, server="GodsEye", server_dir="/srv/brain", explore_only=True)
    (check, check_kw), (mk, _), (scp, _), (_, install_kw) = run.calls
    assert check[-1] == "cd /srv/brain 2>/dev/null || exit 0; [ -e current ] || [ -L current ] || exit 0; cat current/manifest.json"
    assert check_kw["check"] is True
    original = json.loads(before)
    assert run.shipped_manifest == original | {"brain_enabled": False}
    assert (d / "manifest.json").read_bytes() == before  # the bundle on disk is left alone
    assert run.tar_names == sorted(f"{b.version}/{n}" for n in b.files)
    shipped_sum = hashlib.sha256((json.dumps(original | {"brain_enabled": False}, indent=2) + "\n").encode()).hexdigest()
    assert f"{shipped_sum}  manifest.json" in install_kw["input"]  # the server checks the manifest it gets
    assert f"{b.files['exit.onnx']}  exit.onnx" in install_kw["input"]
    assert '"brain_enabled"[[:space:]]*:[[:space:]]*false' in install_kw["input"]


@pytest.mark.parametrize("live", [
    json.dumps({"version": "v0", "brain_enabled": True}),
    json.dumps({"version": "v0"}),  # no flag: from before explore-only pushes, so a promoted model
])
def test_explore_only_refused_while_a_promoted_model_is_live(tmp_path, live):
    run = FakeRun(live=live)
    with pytest.raises(push.PromotedModelLive):
        push.push(write_bundle(tmp_path / "b"), run=run, server="GodsEye", server_dir="/srv/brain", explore_only=True)
    assert [c[0][0] for c in run.calls] == ["ssh"]  # only the check: nothing copied or installed


def test_explore_only_replaces_an_explore_only_model(tmp_path):
    run = FakeRun(live=json.dumps({"version": "v0", "brain_enabled": False}))
    push.push(write_bundle(tmp_path / "b"), run=run, server="GodsEye", server_dir="/srv/brain", explore_only=True)
    assert len(run.calls) == 4 and run.shipped_manifest["brain_enabled"] is False


def test_explore_only_refuses_an_unreadable_live_manifest(tmp_path):
    run = FakeRun(live="{half a manif")
    with pytest.raises(push.BundleError, match="current manifest.json is unreadable"):
        push.push(write_bundle(tmp_path / "b"), run=run, server="GodsEye", server_dir="/srv/brain", explore_only=True)
    assert len(run.calls) == 1


def test_explore_only_is_not_for_social(tmp_path):
    run = FakeRun()
    with pytest.raises(push.BundleError, match="not the social one"):
        push.push(write_bundle(tmp_path / "s", social=True), social=True, run=run, explore_only=True)
    assert run.calls == []
    assert push.main([str(write_bundle(tmp_path / "s2", social=True)), "--social", "--explore-only"]) == 2


def test_plain_push_reads_nothing_from_the_server_first(tmp_path):
    run = FakeRun(live=json.dumps({"version": "v0", "brain_enabled": True}))
    push.push(write_bundle(tmp_path / "b"), run=run, server="GodsEye", server_dir="/srv/brain")
    assert len(run.calls) == 3
    assert "brain_enabled" not in run.calls[-1][1]["input"]
    assert "brain_enabled" not in run.shipped_manifest


def test_main_explore_only_exit_codes(tmp_path, monkeypatch, capsys):
    d = write_bundle(tmp_path / "b")
    real = push.push

    def with_server(live):
        monkeypatch.setattr(push, "push", lambda *a, **kw: real(*a, run=FakeRun(live), **kw))

    with_server(json.dumps({"brain_enabled": True}))
    assert push.main([str(d), "--explore-only"]) == push.PROMOTED_LIVE == 4
    assert "push skipped" in capsys.readouterr().err
    with_server("")
    assert push.main([str(d), "--explore-only"]) == 0
    assert "pushed explore-only model bundle" in capsys.readouterr().out


def live_brain_enabled(base: Path):
    return json.loads((base / "current" / "manifest.json").read_text()).get("brain_enabled")


def test_explore_only_install_on_an_empty_server(tmp_path, server):
    v = "2026-11-07T12-00-00Z"
    server(write_bundle(tmp_path / "b", version=v), explore_only=True)
    assert os.readlink(server.base / "current") == f"models/{v}"
    assert live_brain_enabled(server.base) is False


def test_explore_only_install_replaces_explore_only_but_never_a_promoted_model(tmp_path, server):
    v1, v2, v3 = "2026-11-07T12-00-00Z", "2026-11-07T13-00-00Z", "2026-11-07T14-00-00Z"
    server(write_bundle(tmp_path / "b1", version=v1), explore_only=True)
    server(write_bundle(tmp_path / "b2", version=v2, brain_enabled=True))  # gate exit 0: promoted
    assert live_brain_enabled(server.base) is True
    with pytest.raises(push.PromotedModelLive):
        server(write_bundle(tmp_path / "b3", version=v3), explore_only=True)
    assert os.readlink(server.base / "current") == f"models/{v2}"
    assert sorted(os.listdir(server.base / "models")) == [v1, v2]
    assert [p for p in os.listdir(server.base / "staging") if not p.startswith(".")] == []


def test_install_script_guard_catches_a_promotion_after_the_check(tmp_path, server, monkeypatch):
    v1, v2 = "2026-11-07T12-00-00Z", "2026-11-07T13-00-00Z"
    server(write_bundle(tmp_path / "b1", version=v1, brain_enabled=True))
    monkeypatch.setattr(push, "live_manifest", lambda *a: None)  # the check saw no model; the install script must
    with pytest.raises(push.PromotedModelLive, match="meanwhile"):
        server(write_bundle(tmp_path / "b2", version=v2), explore_only=True)
    assert os.readlink(server.base / "current") == f"models/{v1}"
    assert sorted(os.listdir(server.base / "models")) == [v1]
    assert [p for p in os.listdir(server.base / "staging") if not p.startswith(".")] == []


def test_a_version_pushed_explore_only_can_still_be_promoted(tmp_path, server):
    """Only manifest.json differs between the explore-only copy and the bundle: the promoted push replaces it in place."""
    v = "2026-11-07T12-00-00Z"
    d = write_bundle(tmp_path / "b", version=v, brain_enabled=True)
    server(d, explore_only=True)
    assert live_brain_enabled(server.base) is False
    server(d)  # re-gated: exit 0
    assert os.readlink(server.base / "current") == f"models/{v}"
    assert live_brain_enabled(server.base) is True
    assert (server.base / "current" / "manifest.json").read_text() == (d / "manifest.json").read_text()
    assert not (server.base / "previous").exists()
    assert not any(p.startswith(".install-") for p in os.listdir(server.base / "staging"))


def test_same_version_with_different_networks_is_still_refused_after_explore_only(tmp_path, server):
    v = "2026-11-07T12-00-00Z"
    server(write_bundle(tmp_path / "b", version=v), explore_only=True)
    d2 = write_bundle(tmp_path / "b2", version=v, brain_enabled=True)
    (d2 / "exit.onnx").write_bytes(b"different")
    m = json.loads((d2 / "manifest.json").read_text())
    m["sha256"]["exit.onnx"] = hashlib.sha256(b"different").hexdigest()
    (d2 / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(subprocess.CalledProcessError) as e:
        server(d2)
    assert e.value.returncode == 3
    assert live_brain_enabled(server.base) is False
    assert (server.base / "current" / "exit.onnx").read_bytes() == b"exit-net"


# ---- scripts/cycle.sh: gate -> push, with a fake python and a fake ssh ----

FAKE_PYTHON = """#!/bin/bash
# The cycle's python: answers have(), fakes pull, train and gate, and runs brain.push for real.
if [ "$1" = "-" ]; then
  case "$2" in brain.train|brain.gate|brain.push) exit 0 ;; *) exit 1 ;; esac
fi
case "$2" in
  brain.export.pull) exit 0 ;;
  brain.train) mkdir -p "$BRAIN_DATA_DIR/models" && cp -R "$FAKE_BUNDLE" "$BRAIN_DATA_DIR/models/"; exit $? ;;
  brain.gate) echo "${{@:3}}" >>"$FAKE_GATE_ARGS"; exit "$FAKE_GATE" ;;
esac
exec {python} "$@"
"""
# ssh: the command (last argument) under local bash in the fake server's root, GNU stand-ins first on PATH.
FAKE_SSH = """#!/bin/bash
export PATH="{gnu}:$PATH"
cd {root} && exec bash -c "${{@: -1}}"
"""
FAKE_SCP = """#!/bin/bash
dst="${@: -1}"
exec cp "${@: -2:1}" "${dst#*:}"
"""
CYCLE = Path(__file__).resolve().parents[1] / "scripts" / "cycle.sh"


@pytest.fixture
def cycle(tmp_path):
    """Runs scripts/cycle.sh against a temp data dir, a fake env (python, ssh, scp) and a fake server dir."""
    if sys.platform != "darwin" or not shutil.which("bash"):
        pytest.skip("cycle.sh is the Mac's script (BSD stat)")
    gnu, env_bin = tmp_path / "gnu", tmp_path / "env" / "bin"
    gnu.mkdir()
    env_bin.mkdir(parents=True)
    for name, body in SHIMS.items():
        (gnu / name).write_text(f"#!{sys.executable}\n{body}")
        (gnu / name).chmod(0o755)
    q = shlex.quote
    for name, body in {"python": FAKE_PYTHON.format(python=q(sys.executable)),
                       "ssh": FAKE_SSH.format(gnu=q(str(gnu)), root=q(str(tmp_path))), "scp": FAKE_SCP}.items():
        (env_bin / name).write_text(body)
        (env_bin / name).chmod(0o755)
    data, base = tmp_path / "data", tmp_path / "srv" / "brain"
    data.mkdir()
    gate_args = tmp_path / "gate-args"  # one line per gate call: its arguments after "-m brain.gate"

    def run(gate: int, bundle: Path | None = None, data_dir: Path = data, explore_only: str | None = None):
        """explore_only is CYCLE_EXPLORE_ONLY's value; None leaves it unset (the cycle's default)."""
        env = dict(os.environ, BRAIN_ENV=str(tmp_path / "env"), BRAIN_DATA_DIR=str(data_dir), BRAIN_SERVER="fake",
                   BRAIN_SERVER_DIR=str(base), CYCLE_MODE="hourly", FAKE_GATE=str(gate),
                   FAKE_GATE_ARGS=str(gate_args), FAKE_BUNDLE=str(bundle or tmp_path / "none"))
        env.pop("CYCLE_EXPLORE_ONLY", None)
        if explore_only is not None:
            env["CYCLE_EXPLORE_ONLY"] = explore_only
        p = subprocess.run(["bash", str(CYCLE)], env=env, capture_output=True, text=True, timeout=120)
        logs = sorted((data_dir / "logs").glob("cycle-*.log")) if data_dir.is_dir() else []
        run.log = "".join(f.read_text() for f in logs)
        return p.returncode

    run.base, run.data = base, data
    run.gate_args = lambda: gate_args.read_text().splitlines() if gate_args.exists() else []
    return run


def seed_live(base: Path, version: str, **manifest) -> None:
    (base / "models" / version).mkdir(parents=True)
    (base / "models" / version / "manifest.json").write_text(json.dumps({"version": version, **manifest}))
    os.symlink(f"models/{version}", base / "current")


def test_cycle_gate_3_pushes_explore_only_to_an_empty_server(tmp_path, cycle):
    v = "2026-11-07T12-00-00Z"
    bundle = write_bundle(tmp_path / "bundles" / v, version=v, brain_enabled=True)
    assert cycle(3, bundle) == 0, cycle.log
    assert os.readlink(cycle.base / "current") == f"models/{v}"
    assert live_brain_enabled(cycle.base) is False
    assert json.loads((cycle.data / "models" / v / "manifest.json").read_text())["brain_enabled"] is True
    assert "gate exit 3: explore-only" in cycle.log
    assert "model push --explore-only: exit 0" in cycle.log
    assert "cycle end (ok)" in cycle.log


def test_cycle_gate_3_keeps_a_promoted_model(tmp_path, cycle):
    seed_live(cycle.base, "v0", brain_enabled=True)
    v = "2026-11-07T12-00-00Z"
    assert cycle(3, write_bundle(tmp_path / "bundles" / v, version=v)) == 0, cycle.log
    assert os.readlink(cycle.base / "current") == "models/v0"
    assert not (cycle.base / "models" / v).exists()
    assert "model push --explore-only: exit 4" in cycle.log
    assert "the server runs a promoted model: it keeps it" in cycle.log
    assert "cycle end (ok)" in cycle.log


def test_cycle_gate_3_replaces_an_explore_only_model(tmp_path, cycle):
    seed_live(cycle.base, "v0", brain_enabled=False)
    v = "2026-11-07T12-00-00Z"
    assert cycle(3, write_bundle(tmp_path / "bundles" / v, version=v)) == 0, cycle.log
    assert os.readlink(cycle.base / "current") == f"models/{v}"
    assert live_brain_enabled(cycle.base) is False


def test_cycle_gate_3_pushes_explore_only_by_default(tmp_path, cycle):
    """CONTRACT.md "Promotion": with no promoted model on the server, exit 3 is pushed (brain_enabled false) so the
    Explore account has a model to gather data with; the runtime makes the Brain account skip every signal."""
    v = "2026-11-07T12-00-00Z"
    assert cycle(3, write_bundle(tmp_path / "bundles" / v, version=v)) == 0, cycle.log
    assert os.readlink(cycle.base / "current") == f"models/{v}"
    assert live_brain_enabled(cycle.base) is False
    assert "model push --explore-only: exit 0" in cycle.log


def test_cycle_gate_3_pushes_nothing_with_explore_only_off(tmp_path, cycle):
    seed_live(cycle.base, "v0", brain_enabled=False)
    v = "2026-11-07T12-00-00Z"
    assert cycle(3, write_bundle(tmp_path / "bundles" / v, version=v), explore_only="0") == 0, cycle.log
    assert os.readlink(cycle.base / "current") == "models/v0"
    assert not (cycle.base / "models" / v).exists()
    assert "gate exit 3: explore-only, not pushed (CYCLE_EXPLORE_ONLY=0)" in cycle.log
    assert "model push" not in cycle.log
    assert "cycle end (ok)" in cycle.log


def test_cycle_gate_0_promotes_over_anything(tmp_path, cycle):
    seed_live(cycle.base, "v0", brain_enabled=True)
    v = "2026-11-07T12-00-00Z"
    assert cycle(0, write_bundle(tmp_path / "bundles" / v, version=v, brain_enabled=True)) == 0, cycle.log
    assert os.readlink(cycle.base / "current") == f"models/{v}"
    assert live_brain_enabled(cycle.base) is True
    assert "model push: exit 0" in cycle.log


def test_cycle_gate_never_scores_the_test_window(tmp_path, cycle):
    """TEST (11-02 onward) is used once, by hand, at the end: the hourly gate always runs with --no-test."""
    v = "2026-11-07T12-00-00Z"
    assert cycle(1, write_bundle(tmp_path / "bundles" / v, version=v)) == 0, cycle.log
    calls = cycle.gate_args()
    assert calls == [f"--bundle {cycle.data / 'models' / v} --no-test"], calls


@pytest.mark.parametrize("gate", [1, 2])
def test_cycle_other_gate_exits_push_nothing(tmp_path, cycle, gate):
    v = "2026-11-07T12-00-00Z"
    assert cycle(gate, write_bundle(tmp_path / "bundles" / v, version=v)) == 0, cycle.log
    assert not (cycle.base / "current").exists()
    assert f"gate exit {gate}: the server keeps its current model" in cycle.log


def test_cycle_skips_quietly_when_the_drive_is_missing(tmp_path, cycle):
    gone = tmp_path / "unplugged" / "GodsEyeBrainData"
    assert cycle(0, data_dir=gone) == 0
    assert not gone.exists() and not gone.parent.exists()
    link = tmp_path / "link"  # ~/GodsEyeBrainData pointing at an unmounted drive
    os.symlink(gone, link)
    assert cycle(0, data_dir=link) == 0
    assert not gone.exists()
