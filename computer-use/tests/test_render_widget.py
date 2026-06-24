"""render_widget appends one JSON line to the widgets bus.

Hermetic: the bus path is redirected to a tmp file via JARVIS_WIDGETS_LOG
(mirroring how the agent-pointer tests redirect JARVIS_AGENT_POINTER_LOG). We
call the underlying append helper that the MCP tool wraps, asserting the on-disk
file-bus contract: one compact JSON line {ts, title, spec} per widget.
"""

from __future__ import annotations

import json

import pytest

from computer_use_mcp import widgets_bus

DUCK_SPEC = {
    "type": "column",
    "gap": 6,
    "children": [
        {"type": "text", "text": "Here's your duck 🦆", "size": 16, "color": "#7FF4FF"},
        {"type": "canvas", "w": 160, "h": 140, "ops": [
            {"op": "ellipse", "x": 80, "y": 95, "rx": 48, "ry": 34, "fill": "#FFD23F"},
            {"op": "circle", "x": 120, "y": 55, "r": 24, "fill": "#FFD23F"},
            {"op": "path", "points": [[140, 52], [164, 58], [140, 66]],
             "fill": "#FF8C2B", "close": True},
            {"op": "circle", "x": 126, "y": 50, "r": 4, "fill": "#0A0E16"},
        ]},
    ],
}


@pytest.fixture
def widgets_file(tmp_path, monkeypatch):
    path = tmp_path / "widgets.jsonl"
    monkeypatch.setenv("JARVIS_WIDGETS_LOG", str(path))
    return path


def _lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_render_widget_appends_duck_line(widgets_file):
    rec = widgets_bus.append_widget(DUCK_SPEC, title="Duck")
    lines = _lines(widgets_file)
    assert len(lines) == 1
    got = lines[0]
    assert got["title"] == "Duck"
    assert isinstance(got["ts"], int) and got["ts"] > 0
    # The spec round-trips intact (the duck's bill path survives).
    assert got["spec"] == DUCK_SPEC
    assert got["spec"]["children"][1]["ops"][2]["op"] == "path"
    # The helper returns the same record it wrote.
    assert rec["spec"] == DUCK_SPEC


def test_render_widget_button_action_round_trips(widgets_file):
    spec = {"type": "button", "text": "Refresh", "action": {"send": "refresh the chart"}}
    widgets_bus.append_widget(spec, title="Btn")
    got = _lines(widgets_file)[0]
    assert got["spec"]["type"] == "button"
    assert got["spec"]["action"]["send"] == "refresh the chart"


def test_render_widget_list_rows_round_trip(widgets_file):
    spec = {"type": "list", "rows": [{"text": "a"}, {"text": "b", "badge": "new"}]}
    widgets_bus.append_widget(spec, title="List")
    got = _lines(widgets_file)[0]
    assert got["spec"]["type"] == "list"
    assert len(got["spec"]["rows"]) == 2
    assert got["spec"]["rows"][1]["badge"] == "new"


def test_render_widget_grid_progress_divider_link_round_trip(widgets_file):
    spec = {
        "type": "grid",
        "cols": 2,
        "gap": 8,
        "children": [
            {"type": "progress", "value": 0.8, "color": "#29E7FF"},
            {"type": "divider"},
            {"type": "link", "text": "open", "url": "https://x.test"},
            {"type": "text", "text": "cell"},
        ],
    }
    widgets_bus.append_widget(spec, title="Grid")
    got = _lines(widgets_file)[0]["spec"]
    assert got["type"] == "grid" and got["cols"] == 2
    kids = got["children"]
    assert kids[0]["type"] == "progress" and kids[0]["value"] == 0.8
    assert kids[1]["type"] == "divider"
    assert kids[2]["type"] == "link" and kids[2]["url"] == "https://x.test"


def test_render_widget_update_by_id_keeps_history(widgets_file):
    # Two appends with the SAME id: the append-only bus keeps BOTH lines; the
    # desktop is what collapses them. Both carry id=="p1"; the last reflects 0.8.
    widgets_bus.append_widget(
        {"type": "progress", "value": 0.2}, title="P", widget_id="p1")
    widgets_bus.append_widget(
        {"type": "progress", "value": 0.8}, title="P", widget_id="p1")
    lines = _lines(widgets_file)
    assert len(lines) == 2
    assert all(l["id"] == "p1" for l in lines)
    assert lines[-1]["spec"]["value"] == 0.8


def test_render_widget_id_fallback_present(widgets_file):
    rec = widgets_bus.append_widget({"type": "text", "text": "z"})
    got = _lines(widgets_file)[0]
    # Every record carries a non-empty fallback id (e.g. "w<ts>").
    assert rec["id"] and rec["id"].startswith("w")
    assert got["id"] == rec["id"]


def test_render_widget_one_line_per_call(widgets_file):
    widgets_bus.append_widget({"type": "text", "text": "a"})
    widgets_bus.append_widget({"type": "text", "text": "b"})
    lines = _lines(widgets_file)
    assert [l["spec"]["text"] for l in lines] == ["a", "b"]


def test_render_widget_never_raises_on_bad_path(monkeypatch, tmp_path):
    # Point the bus at a path whose parent is a FILE, so mkdir/open fail —
    # append_widget must swallow it and still return the record.
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    monkeypatch.setenv("JARVIS_WIDGETS_LOG", str(blocker / "sub" / "widgets.jsonl"))
    rec = widgets_bus.append_widget({"type": "text", "text": "z"})
    assert rec["spec"]["text"] == "z"  # no exception propagated
