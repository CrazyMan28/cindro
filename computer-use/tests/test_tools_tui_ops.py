# computer-use/tests/test_tools_tui_ops.py
"""tools_tui_ops proxies to daemon_client.call with the right verb/params."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_tui_ops


def test_tui_list_pages_calls_list_verb():
    with patch.object(tools_tui_ops.daemon_client, "call",
                      return_value={"pages": [{"id": "errorlog"}]}) as m:
        result = json.loads(tools_tui_ops.tui_list_pages())
    m.assert_called_once_with("tui.layout.list", {})
    assert result["pages"][0]["id"] == "errorlog"


def test_tui_add_page_passes_through_fields():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        result = json.loads(tools_tui_ops.tui_add_page(
            page_id="errorlog", title="Error Log", kind="log",
            config='{"path": "/var/log/jarvis.log"}'))
    m.assert_called_once_with("tui.layout.add", {
        "id": "errorlog", "title": "Error Log", "kind": "log",
        "config": {"path": "/var/log/jarvis.log"},
    })
    assert result["ok"] is True


def test_tui_add_page_accepts_native_dict_config():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_add_page(page_id="x", title="X", kind="log", config={"a": 1})
    assert m.call_args[0][1]["config"] == {"a": 1}


def test_tui_edit_page_calls_edit_verb():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_edit_page(page_id="errorlog", config='{"path": "/tmp/x.log"}')
    m.assert_called_once_with("tui.layout.edit",
                              {"id": "errorlog", "config": {"path": "/tmp/x.log"}})


def test_tui_remove_page_calls_remove_verb():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_remove_page(page_id="errorlog")
    m.assert_called_once_with("tui.layout.remove", {"id": "errorlog"})


def test_tui_reorder_pages_accepts_json_list():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_reorder_pages(order='["b", "a"]')
    m.assert_called_once_with("tui.layout.reorder", {"order": ["b", "a"]})


def test_daemon_error_returns_json_error_not_exception():
    with patch.object(tools_tui_ops.daemon_client, "call",
                      side_effect=RuntimeError("reserved page id")):
        result = json.loads(tools_tui_ops.tui_add_page(
            page_id="chat", title="x", kind="log", config="{}"))
    assert "error" in result
