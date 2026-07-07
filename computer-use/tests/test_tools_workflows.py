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


def test_workflow_update_only_sends_provided_fields():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"ok": True}) as m:
        result = json.loads(tools_workflows.workflow_update(
            "sched_1", prompt="new prompt only"))
    m.assert_called_once_with("schedule.update",
                              {"id": "sched_1", "prompt": "new prompt only"})
    assert result == {"ok": True}


def test_workflow_update_maps_trigger_to_cron():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"ok": True}) as m:
        tools_workflows.workflow_update("sched_1", trigger="every 10m")
    assert m.call_args[0][1] == {"id": "sched_1", "cron": "every 10m"}


def test_workflow_update_can_send_all_fields_together():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"ok": True}) as m:
        tools_workflows.workflow_update(
            "sched_1", name="renamed", trigger="0 3 * * *", prompt="p2",
            brain="claude", model="opus", target="host-2",
            report_thread="Alerts")
    assert m.call_args[0][1] == {
        "id": "sched_1", "name": "renamed", "cron": "0 3 * * *",
        "prompt": "p2", "brain": "claude", "model": "opus",
        "target": "host-2", "report_thread": "Alerts",
    }


def test_workflow_update_requires_id():
    result = json.loads(tools_workflows.workflow_update(""))
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


def test_is_webhook_path_rejects_path_confusion_traversal():
    # A crafted path that raw-startswith()-matches the webhook prefix but is
    # actually trying to escape to a different route (e.g. /mcp) via an
    # embedded "../" segment must NOT be treated as a webhook path — it must
    # fall through to the normal bearer-auth middleware.
    assert not tools_workflows.is_webhook_path(
        "/workflows/webhook/x/../../mcp/secret")


def test_is_webhook_path_still_accepts_legit_workflow_id():
    # The fix must not break the real, legitimate case: a single, slash-free
    # workflow id segment.
    assert tools_workflows.is_webhook_path("/workflows/webhook/legit-id-123")


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
            return {"token": "secret", "enabled": True}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "sess_9"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        status, body = tools_workflows.fire_webhook("w1", "secret")
    assert status == 200
    assert body["fired"] is True
    assert body["session_id"] == "sess_9"
    assert ("schedule.run_now", {"id": "w1"}) in calls


def test_fire_webhook_valid_token_but_enabled_true_still_fires():
    # Explicit enabled:True must behave exactly like the (legacy) missing-field
    # case above — no regression from adding the enabled gate.
    with patch.object(tools_workflows.daemon_client, "call",
                      side_effect=lambda method, params=None, timeout=15.0: (
                          {"token": "secret", "enabled": True}
                          if method == "schedule.webhook_token"
                          else {"ok": True, "session_id": "sess_9"})):
        status, body = tools_workflows.fire_webhook("w1", "secret")
    assert status == 200
    assert body["fired"] is True


def test_fire_webhook_missing_enabled_field_fails_closed_403():
    # Bonus fix: a missing/malformed `enabled` field must fail CLOSED (treated
    # as disabled), not fail open (treated as enabled). Guards against a
    # daemon response that omits the field for any reason.
    calls = []

    def fake(method, params=None, timeout=15.0):
        calls.append(method)
        if method == "schedule.webhook_token":
            return {"token": "secret"}  # no "enabled" key at all
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "should-not-fire"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        status, body = tools_workflows.fire_webhook("w1", "secret")
    assert status == 403
    assert body == {"error": "workflow_disabled"}
    assert "schedule.run_now" not in calls


def test_fire_webhook_disabled_workflow_403_even_with_valid_token():
    # Finding 2: disabling a webhook Workflow via schedule.set_enabled must
    # actually stop it from firing on external POSTs, even though the
    # presented token is otherwise correct.
    calls = []

    def fake(method, params=None, timeout=15.0):
        calls.append(method)
        if method == "schedule.webhook_token":
            return {"token": "secret", "enabled": False}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "should-not-fire"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        status, body = tools_workflows.fire_webhook("w1", "secret")
    assert status == 403
    assert body == {"error": "workflow_disabled"}
    # Must short-circuit BEFORE ever calling schedule.run_now.
    assert "schedule.run_now" not in calls


def test_fire_webhook_disabled_workflow_403_does_not_leak_token():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": _LEAK_TOKEN, "enabled": False}):
        status, body = tools_workflows.fire_webhook("w1", _LEAK_TOKEN)
    assert status == 403
    assert _LEAK_TOKEN not in json.dumps(body)


# --- token-leak regression: the stored bearer token must NEVER show up in a
# response body, on ANY outcome branch (missing/unknown/wrong/error/success).

_LEAK_TOKEN = "super-secret-token-xyz123"


def test_fire_webhook_missing_token_401_does_not_leak_token():
    status, body = tools_workflows.fire_webhook("w1", "")
    assert status == 401
    assert _LEAK_TOKEN not in json.dumps(body)


def test_fire_webhook_unknown_workflow_404_does_not_leak_token():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": ""}):
        status, body = tools_workflows.fire_webhook("nope", _LEAK_TOKEN)
    assert status == 404
    assert _LEAK_TOKEN not in json.dumps(body)


def test_fire_webhook_wrong_token_401_does_not_leak_token():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": _LEAK_TOKEN}):
        status, body = tools_workflows.fire_webhook("w1", "an-attackers-guess")
    assert status == 401
    assert _LEAK_TOKEN not in json.dumps(body)


def test_fire_webhook_daemon_error_502_does_not_leak_token():
    def fake(method, params=None, timeout=15.0):
        if method == "schedule.webhook_token":
            return {"token": _LEAK_TOKEN, "enabled": True}
        if method == "schedule.run_now":
            raise RuntimeError("daemon connection refused")
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        status, body = tools_workflows.fire_webhook("w1", _LEAK_TOKEN)
    assert status == 502
    assert _LEAK_TOKEN not in json.dumps(body)


def test_fire_webhook_success_200_does_not_leak_token():
    def fake(method, params=None, timeout=15.0):
        if method == "schedule.webhook_token":
            return {"token": _LEAK_TOKEN, "enabled": True}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "sess_leak_check"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        status, body = tools_workflows.fire_webhook("w1", _LEAK_TOKEN)
    assert status == 200
    assert _LEAK_TOKEN not in json.dumps(body)


def test_webhook_route_http_response_never_contains_stored_token():
    # Same check at the real HTTP-response-body layer (through JSONResponse
    # serialization), not just the python dict fire_webhook() returns.
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    app = FastAPI()
    tools_workflows.register_webhook_route(app)

    def fake(method, params=None, timeout=15.0):
        if method == "schedule.webhook_token":
            return {"token": _LEAK_TOKEN, "enabled": True}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "sess_1"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        client = TestClient(app)
        resp = client.post("/workflows/webhook/w1",
                           headers={"Authorization": f"Bearer {_LEAK_TOKEN}"})
    assert resp.status_code == 200
    assert _LEAK_TOKEN not in resp.text


def test_webhook_route_fires_on_valid_bearer():
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    app = FastAPI()
    tools_workflows.register_webhook_route(app)

    def fake(method, params=None, timeout=15.0):
        if method == "schedule.webhook_token":
            return {"token": "secret", "enabled": True}
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
