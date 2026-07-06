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


# --- webhook ingestion -------------------------------------------------------

def test_is_webhook_path():
    assert tools_workflows.is_webhook_path("/workflows/webhook/abc")
    assert not tools_workflows.is_webhook_path("/health")
    assert not tools_workflows.is_webhook_path("/mcp")


def test_fire_webhook_missing_token_401():
    status, body = tools_workflows.fire_webhook("w1", "")
    assert status == 401


def test_fire_webhook_unknown_workflow_404():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": ""}):
        status, body = tools_workflows.fire_webhook("nope", "whatever")
    assert status == 404


def test_fire_webhook_wrong_token_401():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": "correct-secret"}):
        status, body = tools_workflows.fire_webhook("w1", "wrong-secret")
    assert status == 401


def test_fire_webhook_valid_token_fires_run_now():
    calls = []

    def fake(method, params=None, timeout=15.0):
        calls.append((method, params))
        if method == "schedule.webhook_token":
            return {"token": "secret"}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "sess_9"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        status, body = tools_workflows.fire_webhook("w1", "secret")
    assert status == 200
    assert body["fired"] is True
    assert body["session_id"] == "sess_9"
    assert ("schedule.run_now", {"id": "w1"}) in calls


def test_webhook_route_fires_on_valid_bearer():
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    app = FastAPI()
    tools_workflows.register_webhook_route(app)

    def fake(method, params=None, timeout=15.0):
        if method == "schedule.webhook_token":
            return {"token": "secret"}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "sess_1"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        client = TestClient(app)
        resp = client.post("/workflows/webhook/w1",
                           headers={"Authorization": "Bearer secret"})
    assert resp.status_code == 200
    assert resp.json()["session_id"] == "sess_1"


def test_webhook_route_rejects_bad_bearer():
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    app = FastAPI()
    tools_workflows.register_webhook_route(app)
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": "secret"}):
        client = TestClient(app)
        resp = client.post("/workflows/webhook/w1",
                           headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401
