from pathlib import Path

from proxmox_mcp import state_store


def test_vm_entry_defaults_and_round_trip(tmp_path):
    state_file = tmp_path / "state.json"
    state = state_store.load(state_file)
    entry = state_store.vm_entry(state, 104)
    assert entry == {"pending_restart": False, "last_action": "", "last_action_at": None}
    entry["pending_restart"] = True
    entry["last_action"] = "tuned"
    state_store.save(state_file, state)

    reloaded = state_store.load(state_file)
    assert reloaded["vms"]["104"]["pending_restart"] is True
    assert reloaded["vms"]["104"]["last_action"] == "tuned"


def test_load_missing_state_file_returns_empty():
    assert state_store.load(Path("/nonexistent/x.json")) == {"vms": {}}


def test_blocklist_round_trip(tmp_path):
    blocklist_file = tmp_path / "blocklist.json"
    assert state_store.load_blocklist(blocklist_file) == set()
    state_store.save_blocklist(blocklist_file, [104, 106, 106, 107])
    assert state_store.load_blocklist(blocklist_file) == {104, 106, 107}


def test_blocklist_one_bad_entry_does_not_drop_the_rest(tmp_path):
    # A single malformed vmid must not silently disable protection for every
    # OTHER already-blocklisted VM (e.g. a CI runner someone explicitly
    # protected) — that would be a safety regression with no visible error.
    blocklist_file = tmp_path / "blocklist.json"
    blocklist_file.write_text('{"vmids": [104, "not-a-vmid", 106]}')
    assert state_store.load_blocklist(blocklist_file) == {104, 106}


def test_blocklist_invalid_json_returns_empty_not_stale():
    blocklist_file = Path("/nonexistent/blocklist.json")
    assert state_store.load_blocklist(blocklist_file) == set()
