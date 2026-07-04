"""tools_commands proxies to daemon_client.call, mirroring create_skill."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_commands


def test_create_slash_command_calls_command_create():
    with patch.object(tools_commands.daemon_client, "call", return_value={"ok": True}) as m:
        result = json.loads(tools_commands.create_slash_command(
            name="deploy", description="Deploy the current branch",
            action_kind="shell", action_target="scripts/deploy.sh",
            body="Runs the deploy script."))
    m.assert_called_once_with("command.create", {
        "name": "deploy", "description": "Deploy the current branch",
        "action_kind": "shell", "action_target": "scripts/deploy.sh",
        "body": "Runs the deploy script.",
    })
    assert result["ok"] is True


def test_list_slash_commands_calls_command_list():
    with patch.object(tools_commands.daemon_client, "call",
                      return_value={"commands": []}) as m:
        json.loads(tools_commands.list_slash_commands())
    m.assert_called_once_with("command.list", {})


def test_remove_slash_command_calls_command_remove():
    with patch.object(tools_commands.daemon_client, "call", return_value={"ok": True}) as m:
        json.loads(tools_commands.remove_slash_command(name="deploy"))
    m.assert_called_once_with("command.remove", {"name": "deploy"})


def test_daemon_error_returns_json_error():
    with patch.object(tools_commands.daemon_client, "call",
                      side_effect=RuntimeError("name collides with a built-in")):
        result = json.loads(tools_commands.create_slash_command(
            name="goal", description="x", action_kind="prompt",
            action_target="", body="x"))
    assert "error" in result
