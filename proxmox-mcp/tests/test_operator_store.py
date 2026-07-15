"""Pure-logic tests for the operator permission policy + board stores. No
subprocess, no real filesystem paths (everything takes an explicit tmp path)."""

from proxmox_mcp import operator_store as store


def test_default_policy_is_ask():
    # missing file -> safe default (ask before every risky action)
    assert store.resolve_effect("proxmox_vm_delete", {"vmid": 106},
                                policy={"default_risky": "ask", "rules": []}) == "ask"


def test_default_risky_allow_and_deny():
    allow = {"default_risky": "allow", "rules": []}
    deny = {"default_risky": "deny", "rules": []}
    assert store.resolve_effect("proxmox_vm_power", {"verb": "start"}, policy=allow) == "allow"
    assert store.resolve_effect("proxmox_vm_power", {"verb": "start"}, policy=deny) == "deny"


def test_first_matching_rule_wins():
    policy = {
        "default_risky": "ask",
        "rules": [
            {"id": "r1", "match": {"tool": "proxmox_vm_power", "verb": "start"}, "effect": "allow"},
            {"id": "r2", "match": {"tool": "proxmox_vm_power"}, "effect": "deny"},
        ],
    }
    # start -> first rule (allow); stop -> falls to second rule (deny)
    assert store.resolve_effect("proxmox_vm_power", {"verb": "start"}, policy=policy) == "allow"
    assert store.resolve_effect("proxmox_vm_power", {"verb": "stop"}, policy=policy) == "deny"


def test_vmid_and_method_matching():
    policy = {
        "default_risky": "ask",
        "rules": [
            {"id": "protect-106", "match": {"vmid": 106}, "effect": "deny"},
            {"id": "reads-ok", "match": {"method": "GET"}, "effect": "allow"},
        ],
    }
    assert store.resolve_effect("proxmox_vm_delete", {"vmid": 106}, policy=policy) == "deny"
    assert store.resolve_effect("proxmox_vm_delete", {"vmid": 105}, policy=policy) == "ask"
    # method match is case-insensitive
    assert store.resolve_effect("proxmox_api", {"method": "get"}, policy=policy) == "allow"


def test_empty_match_is_catch_all():
    policy = {"default_risky": "ask", "rules": [{"id": "all", "match": {}, "effect": "deny"}]}
    assert store.resolve_effect("anything", {"vmid": 1}, policy=policy) == "deny"


def test_always_rule_is_scoped_to_one_vmid():
    # An "always allow stop VM 106" rule must NOT allow stop on other VMs.
    policy = {"default_risky": "ask",
              "rules": [{"id": "r", "match": {"tool": "proxmox_vm_power", "verb": "stop", "vmid": 106},
                         "effect": "allow"}]}
    assert store.resolve_effect("proxmox_vm_power", {"verb": "stop", "vmid": 106}, policy=policy) == "allow"
    assert store.resolve_effect("proxmox_vm_power", {"verb": "stop", "vmid": 107}, policy=policy) == "ask"


def test_always_rule_is_scoped_to_one_api_path():
    # An "always" on one proxmox_api POST must NOT allow every POST.
    policy = {"default_risky": "ask",
              "rules": [{"id": "r", "match": {"method": "POST", "path": "/nodes/pve/qemu/100/status/stop"},
                         "effect": "allow"}]}
    ok = store.resolve_effect("proxmox_api", {"method": "POST", "path": "/nodes/pve/qemu/100/status/stop"}, policy=policy)
    other = store.resolve_effect("proxmox_api", {"method": "POST", "path": "/nodes/pve/qemu/999/config"}, policy=policy)
    assert ok == "allow"
    assert other == "ask"


def test_is_mutating_method():
    assert store.is_mutating_method("GET") is False
    assert store.is_mutating_method("get") is False
    assert store.is_mutating_method("POST") is True
    assert store.is_mutating_method("DELETE") is True


def test_free_tools_membership():
    assert "proxmox_vm_list" in store.FREE_TOOLS
    assert "proxmox_dashboard_layout_set" in store.FREE_TOOLS  # board write, auto-allowed
    assert "proxmox_vm_delete" not in store.FREE_TOOLS


def test_policy_round_trip(tmp_path):
    f = tmp_path / "operator_policy.json"
    saved = store.save_policy({"default_risky": "allow",
                               "rules": [{"id": "x", "match": {"method": "DELETE"}, "effect": "ask"}]},
                              path=f)
    assert saved["updated"] > 0
    loaded = store.load_policy(f)
    assert loaded["default_risky"] == "allow"
    assert loaded["rules"][0]["effect"] == "ask"


def test_layout_round_trip(tmp_path):
    f = tmp_path / "operator_layout.json"
    assert store.load_layout(f) == {"tiles": [], "updated": 0}
    store.save_layout({"tiles": [{"id": "t1", "x": 0, "y": 0, "spec": {"type": "text"}}]}, path=f)
    assert store.load_layout(f)["tiles"][0]["id"] == "t1"


def test_tasks_create_and_update(tmp_path):
    f = tmp_path / "operator_tasks.json"
    t = store.create_task("Rebuild CI runner", "vm 104", "todo", path=f)
    assert t["status"] == "todo" and t["id"].startswith("t")
    moved = store.update_task(t["id"], status="doing", path=f)
    assert moved["status"] == "doing"
    assert store.update_task("nope", status="done", path=f) is None
    assert store.load_tasks(f)["tasks"][0]["status"] == "doing"
