import subprocess
import time

from outpost_mcp.pairing import PairingStore


def test_start_returns_oneliners_and_code():
    ps = PairingStore()
    r = ps.start(name="win-box", os_hint="windows")
    assert len(r["pairing_code"]) == 6 and r["pairing_code"].isdigit()
    assert r["bootstrap_id"]
    assert r["install_cmd_linux"].startswith("curl -fsSL http://127.0.0.1:8798/pair/")
    assert r["install_cmd_linux"].endswith("/sh | bash")
    # Windows one-liner MUST be irm -OutFile + &, never iwr|iex.
    assert "irm http://127.0.0.1:8798/pair/" in r["install_cmd_windows"]
    assert "-OutFile" in r["install_cmd_windows"]
    assert "iex" not in r["install_cmd_windows"]


def test_redeem_is_one_shot():
    ps = PairingStore()
    bid = ps.start()["bootstrap_id"]
    assert ps.valid(bid) is True
    assert ps.redeem(bid) is not None
    # second redemption fails
    assert ps.redeem(bid) is None
    assert ps.valid(bid) is False


def test_ttl_expiry():
    ps = PairingStore(ttl_seconds=0)
    bid = ps.start()["bootstrap_id"]
    time.sleep(0.01)
    assert ps.valid(bid) is False
    assert ps.status(bid)["status"] == "expired"
    assert ps.redeem(bid) is None


def test_status_lifecycle():
    ps = PairingStore()
    assert ps.status("nope")["status"] == "unknown"
    bid = ps.start()["bootstrap_id"]
    assert ps.status(bid)["status"] == "pending"
    ps.redeem(bid)
    ps.mark_paired(bid, "m123")
    assert ps.status(bid) == {"status": "paired", "machine_id": "m123"}


def test_render_scripts_embed_ids():
    ps = PairingStore()
    bid = ps.start()["bootstrap_id"]
    sh = ps.render_sh(bid)
    ps1 = ps.render_ps1(bid)
    assert bid in sh and "/agent/download/" in sh and "/complete" in sh
    assert "systemd" in sh
    assert bid in ps1 and "Invoke-WebRequest" in ps1
    # Windows: Scheduled Task in the interactive session, not a service.
    assert "LogonType Interactive" in ps1 and "RunLevel Highest" in ps1


def test_reinstall_safe_while_old_agent_running():
    """Re-pairing a machine whose agent is still running must not fail.

    Linux/macOS: writing straight onto the running binary fails with
    ETXTBSY (curl exit 23), so the download must stage to a temp file and
    rename over $BIN, and the old agent must be stopped before the new
    one starts. Windows: a running exe is locked, so the task/process
    must be stopped before Invoke-WebRequest writes the file."""
    ps = PairingStore()
    bid = ps.start()["bootstrap_id"]
    sh = ps.render_sh(bid)
    assert '-o "$BIN"' not in sh
    assert "mktemp" in sh and 'mv -f "$TMP" "$BIN"' in sh
    assert "systemctl --user stop outpost-agent.service" in sh
    # -x: exact-cmdline match, or any process with $BIN in its argv dies too
    assert 'pkill -xf "$BIN"' in sh
    # old agent must be stopped before the new one is started
    assert (sh.index("systemctl --user stop")
            < sh.index("systemctl --user enable --now outpost-agent.service"))
    ps1 = ps.render_ps1(bid)
    # download staged to a temp file BEFORE the old agent is touched: a
    # failed download must leave the old, working agent running
    assert ps1.index("Invoke-WebRequest") < ps1.index("Stop-ScheduledTask")
    assert "Stop-Process" in ps1 and "Wait-Process" in ps1 and "Move-Item" in ps1
    # match by image name — reading $_.Path can throw on protected processes
    assert "Get-Process -Name 'outpost-agent'" in ps1 and "$_.Path" not in ps1


def test_sh_script_is_valid_bash():
    ps = PairingStore()
    sh = ps.render_sh(ps.start()["bootstrap_id"])
    r = subprocess.run(["bash", "-n"], input=sh, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
