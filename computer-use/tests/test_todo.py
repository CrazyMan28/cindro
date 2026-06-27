"""Model TODO store + checklist-widget builder.

Hermetic: the todo store dir is redirected via JARVIS_TODOS_DIR and the widget
bus via JARVIS_WIDGETS_LOG (mirroring test_render_widget). We exercise the
store helpers + the pure spec builder that the `todo_write` MCP tool wraps, and
assert that writing a todo list ALSO drops a checklist card on the widget bus so
it surfaces in the desktop + phone UI.
"""

from __future__ import annotations

import json

import pytest

from computer_use_mcp import tools_todo


@pytest.fixture
def todo_env(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_TODOS_DIR", str(tmp_path / "todos"))
    monkeypatch.setenv("JARVIS_WIDGETS_LOG", str(tmp_path / "widgets.jsonl"))
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "sess-1")
    return tmp_path


def _bus_lines(tmp_path):
    path = tmp_path / "widgets.jsonl"
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def test_write_normalizes_and_reads_back(todo_env):
    items = tools_todo.write_todos([
        {"text": "  scope the work  ", "status": "done"},
        {"text": "build it", "status": "in_progress"},
        {"text": "ship", "status": "bogus"},   # unknown -> pending
        {"text": "   "},                        # empty -> dropped
        "just a string",                        # bare string -> pending item
    ], session_id="sess-1")
    assert [i["text"] for i in items] == ["scope the work", "build it", "ship", "just a string"]
    assert [i["status"] for i in items] == ["done", "in_progress", "pending", "pending"]
    # Round-trips through the file in a fresh read.
    again = tools_todo.read_todos(session_id="sess-1")
    assert again == items


def test_read_empty_when_unwritten(todo_env):
    assert tools_todo.read_todos(session_id="never") == []


def test_clear_removes_list(todo_env):
    tools_todo.write_todos([{"text": "a"}], session_id="sess-1")
    assert tools_todo.read_todos(session_id="sess-1")
    assert tools_todo.clear_todos(session_id="sess-1") is True
    assert tools_todo.read_todos(session_id="sess-1") == []


def test_widget_spec_has_row_per_item_and_progress(todo_env):
    items = tools_todo.normalize_items([
        {"text": "one", "status": "done"},
        {"text": "two", "status": "in_progress"},
        {"text": "three", "status": "pending"},
    ])
    spec = tools_todo.todo_widget_spec(items)
    assert spec["type"] == "column"
    flat = json.dumps(spec)
    # Each item's text is present, and a "1/3" progress count is shown.
    assert "one" in flat and "two" in flat and "three" in flat
    assert "1/3" in flat


def test_write_emits_checklist_to_widget_bus(todo_env):
    tools_todo.write_todos([
        {"text": "alpha", "status": "done"},
        {"text": "beta", "status": "pending"},
    ], session_id="sess-1")
    lines = _bus_lines(todo_env)
    assert len(lines) == 1
    rec = lines[0]
    # Stable, addressable id so updates replace the card in place.
    assert rec["id"].startswith("__todo__")
    assert rec["session_id"] == "sess-1"
    assert "alpha" in json.dumps(rec["spec"])


def test_rewrite_updates_same_card_id(todo_env):
    tools_todo.write_todos([{"text": "a", "status": "pending"}], session_id="sess-1")
    tools_todo.write_todos([{"text": "a", "status": "done"}], session_id="sess-1")
    lines = _bus_lines(todo_env)
    assert len(lines) == 2
    assert lines[0]["id"] == lines[1]["id"]   # same addressable card


def test_items_get_stable_ids(todo_env):
    items = tools_todo.write_todos(["a", "b", "c"], session_id="sess-1")
    ids = [i["id"] for i in items]
    assert all(ids) and len(set(ids)) == 3           # unique, non-empty


def test_granular_add_edit_done_del(todo_env):
    tools_todo.write_todos([{"text": "scope"}, {"text": "build"}], session_id="sess-1")
    # add one
    items = tools_todo.add_todo("ship", session_id="sess-1")
    assert [i["text"] for i in items] == ["scope", "build", "ship"]
    # done by 1-based position
    items = tools_todo.done_todo("1", session_id="sess-1")
    assert items[0]["status"] == "done"
    # edit by id
    bid = items[1]["id"]
    items = tools_todo.edit_todo(bid, text="build it", status="in_progress", session_id="sess-1")
    assert items[1]["text"] == "build it" and items[1]["status"] == "in_progress"
    # edit by matching text
    items = tools_todo.done_todo("ship", session_id="sess-1")
    assert [i for i in items if i["text"] == "ship"][0]["status"] == "done"
    # delete by id
    items = tools_todo.del_todo(items[0]["id"], session_id="sess-1")
    assert [i["text"] for i in items] == ["build it", "ship"]
    # persists across a fresh read
    assert tools_todo.read_todos(session_id="sess-1") == items
