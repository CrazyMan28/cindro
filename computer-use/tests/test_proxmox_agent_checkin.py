# computer-use/tests/test_proxmox_agent_checkin.py
"""proxmox_agent_checkin filters Project Tracker's active-agent list down to
proxmox-* agents, and degrades to a JSON error instead of raising."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_jarvis_ops


def test_filters_to_proxmox_agents_only():
    with patch.object(tools_jarvis_ops.project_tracker_client, "agent_list_active",
                      return_value={"agents": [
                          {"name": "proxmox-pve", "status": "working"},
                          {"name": "some-other-agent", "status": "idle"},
                      ]}) as m:
        result = json.loads(tools_jarvis_ops.proxmox_agent_checkin())
    m.assert_called_once()
    assert [a["name"] for a in result["agents"]] == ["proxmox-pve"]


def test_no_agents_returns_empty_list():
    with patch.object(tools_jarvis_ops.project_tracker_client, "agent_list_active",
                      return_value={"agents": []}):
        result = json.loads(tools_jarvis_ops.proxmox_agent_checkin())
    assert result == {"agents": []}


def test_unreachable_tracker_returns_json_error_not_exception():
    with patch.object(tools_jarvis_ops.project_tracker_client, "agent_list_active",
                      side_effect=RuntimeError("unreachable")):
        result = json.loads(tools_jarvis_ops.proxmox_agent_checkin())
    assert "error" in result
