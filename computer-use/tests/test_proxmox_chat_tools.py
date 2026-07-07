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
