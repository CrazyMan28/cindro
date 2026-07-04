"""canvas_render mirrors the Android WidgetBitmapRenderer DSL: layout nodes
column/row/grid/text/badge/rect/divider/progress/spacer/list/canvas/pager
and canvas ops circle/ellipse/rect/line/path."""

from rich.console import Console

from jarvis_cli.tui.canvas_render import render_widget_spec


def _render_to_text(renderable) -> str:
    console = Console(width=60, record=True, force_terminal=False)
    console.print(renderable)
    return console.export_text()


def test_text_node_renders_its_content():
    out = _render_to_text(render_widget_spec({"type": "text", "text": "hello widget"}))
    assert "hello widget" in out


def test_column_renders_children_in_order():
    spec = {"type": "column", "children": [
        {"type": "text", "text": "first"}, {"type": "text", "text": "second"},
    ]}
    out = _render_to_text(render_widget_spec(spec))
    assert out.index("first") < out.index("second")


def test_badge_renders_its_label():
    out = _render_to_text(render_widget_spec({"type": "badge", "text": "NEW"}))
    assert "NEW" in out


def test_list_renders_every_row():
    spec = {"type": "list", "rows": [{"text": "row one"}, {"text": "row two"}]}
    out = _render_to_text(render_widget_spec(spec))
    assert "row one" in out and "row two" in out


def test_progress_renders_without_error():
    # No text assertion — a progress bar is drawn as blocks, not literal text.
    render_widget_spec({"type": "progress", "value": 0.5})


def test_divider_renders_without_error():
    render_widget_spec({"type": "divider"})


def test_grid_renders_children():
    spec = {"type": "grid", "cols": 2, "children": [
        {"type": "text", "text": "a"}, {"type": "text", "text": "b"},
        {"type": "text", "text": "c"}, {"type": "text", "text": "d"},
    ]}
    out = _render_to_text(render_widget_spec(spec))
    for expect in ("a", "b", "c", "d"):
        assert expect in out


def test_canvas_op_circle_renders_without_error():
    spec = {"type": "canvas", "w": 40, "h": 20,
            "ops": [{"op": "circle", "x": 5, "y": 5, "r": 3, "fill": "#5FE0FF"}]}
    render_widget_spec(spec)


def test_canvas_op_path_renders_without_error():
    spec = {"type": "canvas", "w": 40, "h": 20,
            "ops": [{"op": "path", "points": [[0, 0], [10, 0], [10, 10]],
                    "stroke": "#5FE0FF", "close": True}]}
    render_widget_spec(spec)


def test_pager_renders_current_page_only():
    spec = {"type": "pager", "page": 1, "pages": [
        {"type": "text", "text": "page zero"}, {"type": "text", "text": "page one"},
    ]}
    out = _render_to_text(render_widget_spec(spec))
    assert "page one" in out and "page zero" not in out


def test_unknown_node_type_renders_a_placeholder_not_a_crash():
    out = _render_to_text(render_widget_spec({"type": "totally_unknown"}))
    assert out.strip() != ""
