# computer-use/tests/test_proxmox_chat_tools.py
"""proxmox_check_status/get_report/give_direction proxy the right RPC verbs
so a plain chat ("check up on proxmox") has tools to reach for."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_jarvis_ops


def test_check_status_proxies_proxmox_status():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"vms": []}) as m:
        result = json.loads(tools_jarvis_ops.proxmox_check_status("pve"))
    m.assert_called_once_with("proxmox.status", {"machine": "pve"})
    assert result == {"vms": []}


def test_get_report_proxies_proxmox_report():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"memories": []}) as m:
        tools_jarvis_ops.proxmox_get_report("pve")
    m.assert_called_once_with("proxmox.report", {"machine": "pve"})


def test_give_direction_proxies_send_directive_with_text():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"ok": True}) as m:
        tools_jarvis_ops.proxmox_give_direction("pve", "prioritize the CI runners")
    m.assert_called_once_with("proxmox.send_directive",
                              {"machine": "pve", "text": "prioritize the CI runners"})


def test_all_three_degrade_to_json_error_not_exception():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      side_effect=RuntimeError("daemon down")):
        assert "error" in json.loads(tools_jarvis_ops.proxmox_check_status("pve"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_get_report("pve"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_give_direction("pve", "x"))


def test_scout_proxies_with_and_without_vmids():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"ok": True, "started": True}) as m:
        tools_jarvis_ops.proxmox_scout("pve")
    m.assert_called_once_with("proxmox.scout", {"machine": "pve"}, timeout=30)
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"ok": True, "started": True}) as m:
        tools_jarvis_ops.proxmox_scout("pve", [104, 106])
    m.assert_called_once_with("proxmox.scout",
                              {"machine": "pve", "vmids": [104, 106]}, timeout=30)


def test_scout_status_and_profile_and_questions_proxy():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"scout": {"state": "idle"}}) as m:
        tools_jarvis_ops.proxmox_scout_status("pve")
    m.assert_called_once_with("proxmox.scout_status", {"machine": "pve"}, timeout=30)

    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"vmid": 104, "exists": True, "profile": "# VM"}) as m:
        tools_jarvis_ops.proxmox_vm_profile("pve", 104)
    m.assert_called_once_with("proxmox.vm_profile",
                              {"machine": "pve", "vmid": 104}, timeout=30)

    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"questions": []}) as m:
        tools_jarvis_ops.proxmox_list_questions("pve")
    m.assert_called_once_with("proxmox.questions", {"machine": "pve"}, timeout=30)

    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"ok": True, "qid": "q-1"}) as m:
        tools_jarvis_ops.proxmox_answer_question("pve", "q-1", "CI runner")
    m.assert_called_once_with(
        "proxmox.answer", {"machine": "pve", "qid": "q-1", "answer": "CI runner"},
        timeout=30)


def test_ask_agent_returns_reply_when_it_arrives():
    calls = []

    def fake_call(method, params, timeout=30):
        calls.append(method)
        if method == "proxmox.ask_agent":
            return {"ok": True, "rid": "t-1-ab"}
        return {"rid": "t-1-ab", "pending": False, "reply": "nginx is fine",
                "replied_at": 123}

    with patch.object(tools_jarvis_ops.daemon_client, "call", side_effect=fake_call), \
         patch("time.sleep"):
        result = json.loads(tools_jarvis_ops.proxmox_ask_agent("pve", "how's nginx?"))
    assert calls[0] == "proxmox.ask_agent" and "proxmox.agent_reply" in calls
    assert result == {"ok": True, "rid": "t-1-ab", "reply": "nginx is fine",
                      "replied_at": 123}


def test_ask_agent_times_out_to_pending():
    def fake_call(method, params, timeout=30):
        if method == "proxmox.ask_agent":
            return {"ok": True, "rid": "t-2-cd"}
        return {"rid": "t-2-cd", "pending": True}

    with patch.object(tools_jarvis_ops.daemon_client, "call", side_effect=fake_call), \
         patch("time.sleep"), \
         patch("time.time", side_effect=[0, 1, 2, 100, 101]):
        result = json.loads(tools_jarvis_ops.proxmox_ask_agent(
            "pve", "long task", kind="task", wait_sec=10))
    assert result["pending"] is True and result["rid"] == "t-2-cd"


def test_pinged_tools_proxy():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"rules": [], "events": []}) as m:
        tools_jarvis_ops.proxmox_pinged_list("pve")
    m.assert_called_once_with("proxmox.pinged_list", {"machine": "pve"}, timeout=30)

    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"ok": True}) as m:
        tools_jarvis_ops.proxmox_pinged_add(
            "pve", "runner-watch", "check and fix, don't break",
            vmid=104, condition="runner looks stuck")
    m.assert_called_once_with("proxmox.pinged_add", {
        "machine": "pve", "name": "runner-watch",
        "action": "check and fix, don't break", "vmid": 104,
        "condition": "runner looks stuck", "time": ""}, timeout=30)

    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"ok": True}) as m:
        tools_jarvis_ops.proxmox_pinged_remove("pve", "p-1")
    m.assert_called_once_with("proxmox.pinged_remove",
                              {"machine": "pve", "rule_id": "p-1"}, timeout=30)


def test_new_tools_degrade_to_json_error():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      side_effect=RuntimeError("daemon down")):
        assert "error" in json.loads(tools_jarvis_ops.proxmox_scout("pve"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_scout_status("pve"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_vm_profile("pve", 104))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_list_questions("pve"))
        assert "error" in json.loads(
            tools_jarvis_ops.proxmox_answer_question("pve", "q-1", "x"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_ask_agent("pve", "x"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_pinged_list("pve"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_pinged_add(
            "pve", "n", "a", condition="c"))
        assert "error" in json.loads(tools_jarvis_ops.proxmox_pinged_remove("pve", "p-1"))
