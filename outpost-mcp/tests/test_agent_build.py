"""Self-heal build of the outpost-agent binaries (the fix for a fresh hub 404ing
every pairing because agent-bin/ is gitignored and never shipped)."""
import os

from outpost_mcp import agent_build


def test_known_targets_match_build_script():
    # The allow-list must equal exactly what outpost-agent/build.sh cross-compiles;
    # a request outside it is rejected (also blocks GOOS/path injection).
    assert ("linux", "amd64") in agent_build.KNOWN_TARGETS
    assert ("windows", "amd64") in agent_build.KNOWN_TARGETS
    assert len(agent_build.KNOWN_TARGETS) == 6


def test_binary_name_windows_gets_exe():
    assert agent_build.binary_name("linux", "amd64") == "outpost-agent-linux-amd64"
    assert agent_build.binary_name("windows", "amd64") == "outpost-agent-windows-amd64.exe"


def test_unknown_target_rejected_without_building(monkeypatch):
    # An unknown os/arch never shells out to `go` — it returns None immediately.
    called = {"n": 0}
    monkeypatch.setattr(agent_build.shutil, "which", lambda _n: (_ for _ in ()).throw(AssertionError("should not probe go")))
    assert agent_build.ensure_agent_binary("plan9", "sparc") is None
    assert agent_build.ensure_agent_binary("linux", "../etc") is None


def test_existing_binary_served_without_building(tmp_path, monkeypatch):
    # If the binary already exists, ensure_agent_binary returns it and never builds.
    monkeypatch.setenv("OUTPOST_AGENT_BIN_DIR", str(tmp_path))
    monkeypatch.setattr(agent_build.shutil, "which",
                        lambda _n: (_ for _ in ()).throw(AssertionError("should not build when present")))
    dest = tmp_path / "outpost-agent-linux-amd64"
    dest.write_bytes(b"\x7fELF stub")
    got = agent_build.ensure_agent_binary("linux", "amd64")
    assert got == dest and got.exists()


def test_missing_binary_without_go_returns_none(tmp_path, monkeypatch):
    # No cached binary and no Go toolchain -> None (caller serves a clear 404),
    # never a crash.
    monkeypatch.setenv("OUTPOST_AGENT_BIN_DIR", str(tmp_path))
    monkeypatch.setattr(agent_build.shutil, "which", lambda _n: None)
    assert agent_build.ensure_agent_binary("linux", "amd64") is None
