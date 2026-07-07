"""Pure-logic tests for the Proxmox tuning safety rails. No subprocess, no
config module import — every function here takes plain data, which is the
whole point of keeping proxmox_ops's decision half free of I/O."""

from proxmox_mcp import proxmox_ops as ops

CFG = {
    "cooldown_minutes": 15,
    "reserve_cores": 2,
    "reserve_mem_mb": 4096,
    "bump_step_cores": 2,
    "bump_step_mem_mb": 2048,
    "max_cores_per_vm": 16,
    "max_mem_mb_per_vm": 32768,
    "cpu_congested_pct": 85.0,
    "mem_congested_pct": 90.0,
}


def test_parse_qm_list():
    out = (
        "      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID\n"
        "       104 pve-ubuntu-runner-1  running    8192       64.00        12345\n"
        "       106 win-runner-1         stopped    16384      128.00       0\n"
    )
    vms = ops.parse_qm_list(out)
    assert vms == [
        {"vmid": 104, "name": "pve-ubuntu-runner-1", "status": "running", "mem_mb": 8192},
        {"vmid": 106, "name": "win-runner-1", "status": "stopped", "mem_mb": 16384},
    ]


def test_parse_qm_config_and_hotplug():
    out = "cores: 4\nmemory: 8192\nhotplug: disk,network,cpu,memory\nname: test-vm\n"
    cfg = ops.parse_qm_config(out)
    assert cfg["cores"] == 4 and cfg["memory"] == 8192
    assert cfg["hotplug"] == {"disk", "network", "cpu", "memory"}
    assert ops.hotplug_supports(cfg["hotplug"], "cpu") is True
    assert ops.hotplug_supports(cfg["hotplug"], "usb") is False


def test_parse_qm_config_missing_hotplug_defaults_empty():
    cfg = ops.parse_qm_config("cores: 2\nmemory: 2048\n")
    assert cfg["hotplug"] == set()
    assert ops.hotplug_supports(cfg["hotplug"], "cpu") is False


def test_clamp_bump_respects_step_and_cap():
    # requested way more than the step cap -> capped to current+step
    assert ops.clamp_bump(current=4, requested=32, step_cap=2, per_vm_cap=16) == 6
    # requested within step but over the per-VM cap -> capped to per_vm_cap
    assert ops.clamp_bump(current=15, requested=17, step_cap=4, per_vm_cap=16) == 16


def test_in_cooldown():
    now = 1_000_000_000
    assert ops.in_cooldown(now - 5 * 60_000, now, cooldown_minutes=15) is True
    assert ops.in_cooldown(now - 20 * 60_000, now, cooldown_minutes=15) is False
    assert ops.in_cooldown(None, now, cooldown_minutes=15) is False


def test_host_headroom_ok_and_rejected():
    vms = [{"cores": 4, "memory": 8192}, {"cores": 4, "memory": 8192}]
    ok, _ = ops.host_headroom_ok(vms, node_cores=16, node_mem_mb=32768, cfg=CFG,
                                 delta_cores=2, delta_mem_mb=2048)
    assert ok is True
    # Pushing cores past (16 - reserve_cores=2) = 14 must be rejected.
    ok, reason = ops.host_headroom_ok(vms, node_cores=16, node_mem_mb=32768, cfg=CFG,
                                      delta_cores=8, delta_mem_mb=0)
    assert ok is False and "core headroom" in reason


def test_decide_tune_happy_path_hotplug_live():
    d = ops.decide_tune(
        vmid=104, blocklist=set(), requested_cores=6, requested_memory_mb=0,
        current_cores=4, current_memory_mb=8192, hotplug={"cpu", "memory"},
        all_vm_configs=[{"cores": 4, "memory": 8192}],
        node_cores=16, node_mem_mb=32768, cfg=CFG,
        last_action_at_ms=None, now_ms=1_000_000_000,
    )
    assert d["ok"] is True
    assert d["cores"] == 6  # within the step cap (bump_step_cores=2)
    assert d["applied_live_cores"] is True
    assert d["memory_mb"] is None


def test_decide_tune_no_hotplug_flags_not_live():
    d = ops.decide_tune(
        vmid=104, blocklist=set(), requested_cores=6, requested_memory_mb=0,
        current_cores=4, current_memory_mb=8192, hotplug=set(),
        all_vm_configs=[{"cores": 4, "memory": 8192}],
        node_cores=16, node_mem_mb=32768, cfg=CFG,
        last_action_at_ms=None, now_ms=1_000_000_000,
    )
    assert d["ok"] is True
    assert d["applied_live_cores"] is False  # config written, but needs a restart


def test_decide_tune_blocklisted_rejected():
    d = ops.decide_tune(
        vmid=104, blocklist={104}, requested_cores=6, requested_memory_mb=0,
        current_cores=4, current_memory_mb=8192, hotplug={"cpu"},
        all_vm_configs=[{"cores": 4, "memory": 8192}],
        node_cores=16, node_mem_mb=32768, cfg=CFG,
        last_action_at_ms=None, now_ms=1_000_000_000,
    )
    assert d == {"ok": False, "reason": "blocklisted"}


def test_decide_tune_cooldown_rejected():
    now = 1_000_000_000
    d = ops.decide_tune(
        vmid=104, blocklist=set(), requested_cores=6, requested_memory_mb=0,
        current_cores=4, current_memory_mb=8192, hotplug={"cpu"},
        all_vm_configs=[{"cores": 4, "memory": 8192}],
        node_cores=16, node_mem_mb=32768, cfg=CFG,
        last_action_at_ms=now - 5 * 60_000, now_ms=now,
    )
    assert d == {"ok": False, "reason": "cooldown"}


def test_decide_tune_headroom_rejected():
    # node_cores=6, reserve_cores=2 -> max_cores=4, already fully used by this
    # one VM's current 4 cores; even the step-capped +2 bump has nowhere to go.
    tight_cfg = {**CFG, "reserve_cores": 2}
    d = ops.decide_tune(
        vmid=104, blocklist=set(), requested_cores=16, requested_memory_mb=0,
        current_cores=4, current_memory_mb=8192, hotplug={"cpu"},
        all_vm_configs=[{"cores": 4, "memory": 8192}],
        node_cores=6, node_mem_mb=32768, cfg=tight_cfg,
        last_action_at_ms=None, now_ms=1_000_000_000,
    )
    assert d["ok"] is False and "headroom" in d["reason"]


def test_decide_tune_nothing_requested_or_already_at_cap():
    d = ops.decide_tune(
        vmid=104, blocklist=set(), requested_cores=None, requested_memory_mb=None,
        current_cores=4, current_memory_mb=8192, hotplug={"cpu"},
        all_vm_configs=[{"cores": 4, "memory": 8192}],
        node_cores=16, node_mem_mb=32768, cfg=CFG,
        last_action_at_ms=None, now_ms=1_000_000_000,
    )
    assert d["ok"] is False and "nothing to apply" in d["reason"]


def test_is_congested():
    assert ops.is_congested(90.0, 10.0, CFG) is True   # cpu over threshold
    assert ops.is_congested(10.0, 95.0, CFG) is True   # mem over threshold
    assert ops.is_congested(10.0, 10.0, CFG) is False
