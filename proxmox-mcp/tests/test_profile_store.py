"""JARVIS.md profile round-trips — the load-bearing property is that a
re-scan NEVER eats the user's Purpose/Preferences/Notes."""

from proxmox_mcp import profile_store

OBSERVED = {
    "hostname": ["ci-runner-1"],
    "os": ['PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', 'NAME="Debian GNU/Linux"'],
    "services": [f"svc{i}.service" for i in range(30)],
    "ports": ["0.0.0.0:22 sshd"],
    "docker": ["runner\tmyimg\tUp 3 days"],
    "disk": ["/dev/sda1 40G 25G 15G 62% /"],
    "top": ["root 1 0.0 init"],
    "mem": ["Mem: 8000 4000 4000"],
}


def test_update_observed_creates_skeleton(tmp_path):
    text = profile_store.update_observed(tmp_path, 104, "ci-runner", "qemu",
                                         "linux", OBSERVED, True, 1000)
    assert text.startswith("# VM 104 — ci-runner (qemu)")
    meta = profile_store.read_meta(text)
    assert meta["vmid"] == 104 and meta["kind"] == "qemu"
    assert meta["os_family"] == "linux" and meta["observed_at"] == 1000
    sections = profile_store.parse_sections(text)
    assert "(unknown" in sections["Purpose"]
    assert "Debian GNU/Linux 12" in sections["Observed"]
    assert "guest agent: yes" in sections["Observed"]


def test_update_observed_caps_long_lists(tmp_path):
    text = profile_store.update_observed(tmp_path, 104, "ci-runner", "qemu",
                                         "linux", OBSERVED, True, 1000)
    observed = profile_store.parse_sections(text)["Observed"]
    assert observed.count("svc") == 25  # capped
    assert "… 5 more" in observed


def test_rescan_preserves_user_sections_byte_for_byte(tmp_path):
    profile_store.update_observed(tmp_path, 104, "ci-runner", "qemu", "linux",
                                  OBSERVED, True, 1000)
    purpose = "CI runner for the jarvis repo.\n\nRuns GitHub Actions jobs — bursts are normal!"
    prefs = "- never tune below 4 cores\n- ask before touching docker"
    profile_store.set_user_section(tmp_path, 104, "Purpose", purpose, 2000)
    profile_store.set_user_section(tmp_path, 104, "Preferences", prefs, 2100)

    profile_store.update_observed(tmp_path, 104, "ci-runner", "qemu", "linux",
                                  {"hostname": ["renamed"]}, True, 3000)
    sections = profile_store.parse_sections(profile_store.load(tmp_path, 104))
    assert sections["Purpose"] == purpose
    assert sections["Preferences"] == prefs
    assert "renamed" in sections["Observed"]
    meta = profile_store.read_meta(profile_store.load(tmp_path, 104))
    assert meta["observed_at"] == 3000


def test_set_user_section_refuses_observed(tmp_path):
    result = profile_store.set_user_section(tmp_path, 104, "Observed", "hax", 1000)
    assert result["ok"] is False and "scout-owned" in result["error"]


def test_set_user_section_on_missing_profile_creates_it(tmp_path):
    result = profile_store.set_user_section(tmp_path, 200, "Purpose", "backup box", 1000)
    assert result["ok"] is True
    sections = profile_store.parse_sections(profile_store.load(tmp_path, 200))
    assert sections["Purpose"] == "backup box"
    assert sections["Observed"] == "(not scouted yet)"


def test_lxc_profile_agent_na(tmp_path):
    text = profile_store.update_observed(tmp_path, 100, "web-ct", "lxc",
                                         "linux", {"hostname": ["web"]}, None, 1000)
    assert "guest agent: n/a (lxc)" in text


def test_list_profiles_staleness_and_purpose(tmp_path):
    day_ms = 24 * 3600 * 1000
    profile_store.update_observed(tmp_path, 104, "ci", "qemu", "linux",
                                  OBSERVED, True, 1000)
    profile_store.set_user_section(tmp_path, 104, "Purpose", "CI runner", 1000)
    profile_store.update_observed(tmp_path, 105, "mystery", "qemu", "linux",
                                  OBSERVED, True, 1000)
    (tmp_path / "junk.md").write_text("# not a vm profile")

    rows = profile_store.list_profiles(tmp_path, now_ms=1000 + 8 * day_ms, stale_days=7)
    by_vmid = {r["vmid"]: r for r in rows}
    assert set(by_vmid) == {104, 105}
    assert by_vmid[104]["has_purpose"] is True
    assert by_vmid[105]["has_purpose"] is False
    assert by_vmid[104]["stale"] is True  # observed 8 days before now

    fresh = profile_store.list_profiles(tmp_path, now_ms=1000 + day_ms, stale_days=7)
    assert all(not r["stale"] for r in fresh)


def test_missing_dir_lists_empty(tmp_path):
    assert profile_store.list_profiles(tmp_path / "nope", 1000) == []
