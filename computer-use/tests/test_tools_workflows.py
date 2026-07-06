# computer-use/tests/test_tools_workflows.py
"""workflow_* tools proxy schedule.* verbs and mint webhook tokens."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_workflows


def test_workflow_create_cron_passes_trigger_as_cron():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "sched_1"}) as m:
        result = json.loads(tools_workflows.workflow_create(
            name="nightly-runner-check", trigger="0 2 * * *",
            prompt="check runner", brain="api",
            model="mistral-large-latest", target="ci-runner-104"))
    method, params = m.call_args[0][0], m.call_args[0][1]
    assert method == "schedule.create"
    assert params["cron"] == "0 2 * * *"
    assert params["target"] == "ci-runner-104"
    assert params["report_thread"] == "Workflows"   # default
    assert params["brain"] == "api"
    assert params["model"] == "mistral-large-latest"
    assert "token" not in params
    assert result == {"id": "sched_1"}


def test_workflow_create_defaults_report_thread_when_blank():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "s"}) as m:
        tools_workflows.workflow_create(name="n", trigger="every 5m", prompt="p")
    assert m.call_args[0][1]["report_thread"] == "Workflows"


def test_workflow_create_honors_explicit_report_thread():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "s"}) as m:
        tools_workflows.workflow_create(name="n", trigger="every 5m", prompt="p",
                                        report_thread="Runners")
    assert m.call_args[0][1]["report_thread"] == "Runners"


def test_workflow_create_webhook_mints_token_and_url(monkeypatch):
    monkeypatch.setenv("JARVIS_WEBHOOK_BASE", "http://100.64.0.1:8794")
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "sched_wh"}) as m:
        result = json.loads(tools_workflows.workflow_create(
            name="deploy-hook", trigger="webhook", prompt="handle deploy"))
    params = m.call_args[0][1]
    assert params["cron"] == "webhook"
    assert params["token"] and len(params["token"]) >= 32
    assert result["id"] == "sched_wh"
    assert result["webhook_url"] == "http://100.64.0.1:8794/workflows/webhook/sched_wh"
    assert result["token"] == params["token"]


def test_workflow_create_requires_fields():
    result = json.loads(tools_workflows.workflow_create(name="", trigger="every 5m", prompt="p"))
    assert "error" in result


def test_workflow_list_maps_cron_to_trigger_and_new_fields():
    rows = {"schedules": [{"id": "s1", "name": "nightly", "cron": "0 2 * * *",
                           "target": "ci-runner-104", "report_thread": "Workflows",
                           "brain": "api", "model": "mistral-large-latest",
                           "next_run": 111, "last_run": 0, "enabled": True}]}
    with patch.object(tools_workflows.daemon_client, "call", return_value=rows):
        result = json.loads(tools_workflows.workflow_list())
    wf = result["workflows"][0]
    assert wf["trigger"] == "0 2 * * *"
    assert wf["target"] == "ci-runner-104"
    assert wf["report_thread"] == "Workflows"
    assert wf["next_run"] == 111
    assert wf["model"] == "mistral-large-latest"


def test_workflow_delete_maps_ok_to_deleted():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"ok": True}) as m:
        result = json.loads(tools_workflows.workflow_delete("sched_1"))
    m.assert_called_once_with("schedule.remove", {"id": "sched_1"})
    assert result == {"ok": True, "deleted": True}
