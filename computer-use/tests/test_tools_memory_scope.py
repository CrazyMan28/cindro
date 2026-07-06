# computer-use/tests/test_tools_memory_scope.py
"""remember/recall proxy the right memory.* verbs and add agent scope."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_jarvis_ops


def test_remember_without_agent_omits_agent():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"id": "mem_1"}) as m:
        result = json.loads(tools_jarvis_ops.remember("dark mode", ["prefs"]))
    m.assert_called_once_with("memory.add", {"text": "dark mode", "tags": ["prefs"]})
    assert result["id"] == "mem_1"


def test_remember_with_agent_adds_scope():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"id": "mem_2"}) as m:
        tools_jarvis_ops.remember("runner healthy", agent="ci-runner-104")
    m.assert_called_once_with("memory.add",
                              {"text": "runner healthy", "tags": [],
                               "agent": "ci-runner-104"})


def test_recall_without_agent_matches_legacy_shape():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"memories": []}) as m:
        tools_jarvis_ops.recall("dark mode")
    m.assert_called_once_with("memory.search", {"q": "dark mode", "limit": 20})


def test_recall_with_agent_filters_by_scope():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"memories": []}) as m:
        tools_jarvis_ops.recall(agent="ci-runner-104")
    m.assert_called_once_with("memory.search",
                              {"q": "", "limit": 20, "agent": "ci-runner-104"})


def test_remember_error_returns_json_error_not_exception():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      side_effect=RuntimeError("boom")):
        result = json.loads(tools_jarvis_ops.remember("x"))
    assert "error" in result
