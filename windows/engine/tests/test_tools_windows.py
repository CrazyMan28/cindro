"""Linux-runnable tests for the Windows-only tools layer (Win32 absent).

Covers the human-style input primitives (smooth drag, held input + watchdog,
modifier clicks), the clipboard table codecs, the platform-module patches and
their desktop_reset safety rule, and tool registration on a FastMCP instance.
"""

from __future__ import annotations

import asyncio
import json
import random
import types

import pytest

import backend_windows as bw
import tools_windows as tw
import win_office
import win_platform as wp
import win_uia


def _lines(path):
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


@pytest.fixture
def bus_file(tmp_path, monkeypatch):
    path = tmp_path / "agent_pointer.jsonl"
    monkeypatch.setenv("JARVIS_AGENT_POINTER_LOG", str(path))
    return path


@pytest.fixture
def rec(monkeypatch, bus_file):
    """Record every injected event as a readable tuple, hermetically (bus events
    go to a temp file, never the real ~/.local/share/jarvis pointer log)."""
    events: list[tuple] = []
    fake = types.SimpleNamespace(
        MOUSEEVENTF_LEFTDOWN=0x2, MOUSEEVENTF_LEFTUP=0x4,
        MOUSEEVENTF_RIGHTDOWN=0x8, MOUSEEVENTF_RIGHTUP=0x10,
        MOUSEEVENTF_MIDDLEDOWN=0x20, MOUSEEVENTF_MIDDLEUP=0x40,
        MOUSEEVENTF_WHEEL=0x800, MOUSEEVENTF_HWHEEL=0x1000,
    )
    names = {0x2: "ldown", 0x4: "lup", 0x8: "rdown", 0x10: "rup"}
    monkeypatch.setattr(bw, "_winapi", lambda: fake)
    monkeypatch.setattr(bw, "_mouse_input",
                        lambda dx, dy, data, flags: ("mouse", names.get(flags, flags), data))
    monkeypatch.setattr(bw, "_key_input",
                        lambda vk, up=False, extended=False, scan=0, unicode=False:
                        ("key", scan if unicode else vk, "up" if up else "down"))
    monkeypatch.setattr(bw, "_send", lambda *evs: events.extend(evs))
    monkeypatch.setattr(bw, "_mouse_move_abs", lambda gx, gy: events.append(("move", gx, gy)))
    monkeypatch.setattr(bw, "_cursor_pos", lambda: (0, 0))
    monkeypatch.setattr(bw._screen, "map_to_desktop",
                        lambda x, y, cs="image", which="active": (int(x), int(y)))
    monkeypatch.setattr(bw.time, "sleep", lambda *_a, **_k: None)
    monkeypatch.setattr(bw, "load_config", lambda: {"scroll_invert": False})
    monkeypatch.setattr(bw, "_HELD", {})
    monkeypatch.setattr(bw, "_arm_watchdog", lambda: None)
    return events


# ---------------------------------------------------------------------------
# smooth_path
# ---------------------------------------------------------------------------
def test_smooth_path_ends_exactly_on_target_with_bounded_jitter():
    rng = random.Random(7)
    pts = bw.smooth_path((100, 100), (400, 250), 12, jitter=2, rng=rng)
    assert len(pts) == 12
    assert pts[-1] == (400, 250)
    for i, (px, py) in enumerate(pts[:-1], start=1):
        ex = round(100 + 300 * i / 12)
        ey = round(100 + 150 * i / 12)
        assert abs(px - ex) <= 2 and abs(py - ey) <= 2


def test_smooth_path_single_step_is_the_target():
    assert bw.smooth_path((0, 0), (50, 60), 1) == [(50, 60)]
    assert bw.smooth_path((0, 0), (50, 60), 0) == [(50, 60)]


def test_smooth_path_without_jitter_is_linear():
    assert bw.smooth_path((0, 0), (40, 0), 4, jitter=0) == [(10, 0), (20, 0), (30, 0), (40, 0)]


# ---------------------------------------------------------------------------
# drag_smooth: a real hold -> travel -> release
# ---------------------------------------------------------------------------
def test_drag_smooth_holds_button_through_intermediate_moves(rec, bus_file):
    out = bw.drag_smooth(10, 20, 210, 120, steps=12, step_delay_ms=30)
    assert out["dragged"] is True and out["to"] == [210, 120]
    down = rec.index(("mouse", "ldown", 0))
    up = rec.index(("mouse", "lup", 0))
    assert rec[0] == ("move", 10, 20)                 # move to start BEFORE pressing
    moves_while_held = [e for e in rec[down:up] if e[0] == "move"]
    assert len(moves_while_held) == 12
    assert moves_while_held[-1] == ("move", 210, 120)  # release lands on target
    kinds = [e["kind"] for e in _lines(bus_file)]
    assert kinds[0] == "down" and kinds[-1] == "up" and kinds.count("drag") == 12
    assert all(e["session"] == "real" for e in _lines(bus_file))


def test_drag_smooth_releases_button_even_if_a_move_fails(rec, monkeypatch):
    calls = {"n": 0}

    def flaky(gx, gy):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("boom")
        rec.append(("move", gx, gy))

    monkeypatch.setattr(bw, "_mouse_move_abs", flaky)
    with pytest.raises(RuntimeError):
        bw.drag_smooth(0, 0, 100, 100, steps=5)
    assert rec[-1] == ("mouse", "lup", 0)


def test_drag_smooth_clamps_steps_and_delay(rec):
    out = bw.drag_smooth(0, 0, 10, 10, steps=10_000, step_delay_ms=99_999)
    assert out["steps"] == 200 and out["step_delay_ms"] == 1000


def test_drag_smooth_rejects_bad_button(rec):
    with pytest.raises(ValueError):
        bw.drag_smooth(0, 0, 1, 1, button="thumb")


def test_drag_single_step_no_longer_overshoots(rec):
    """Regression: drag(steps=1) used t=i/steps over range(1, 3) -> t=2, i.e.
    the cursor travelled a whole drag length PAST the target before release."""
    bw.drag(0, 0, 100, 100, coord_space="desktop", steps=1)
    moves = [e for e in rec if e[0] == "move"]
    assert all(0 <= x <= 100 and 0 <= y <= 100 for _m, x, y in moves)
    assert moves[-1] == ("move", 100, 100)


# ---------------------------------------------------------------------------
# held input + watchdog
# ---------------------------------------------------------------------------
def test_key_down_up_tracks_held_keys(rec):
    bw.key_down("shift")
    assert ("key", 0x10) in bw._HELD
    bw.key_up("shift")
    assert bw._HELD == {}
    assert rec == [("key", 0x10, "down"), ("key", 0x10, "up")]


def test_release_all_frees_keys_then_buttons(rec):
    bw.mouse_down(5, 5)
    bw.key_down("ctrl")
    rec.clear()
    out = bw.release_all()
    assert bw._HELD == {}
    assert rec == [("key", 0x11, "up"), ("mouse", "lup", 0)]
    assert set(out["released"]) == {"key:17", "button:left"}


def test_watchdog_sweep_releases_only_stale_entries(rec, monkeypatch):
    monkeypatch.setattr(bw, "_HOLD_MAX_S", 15.0)
    bw._HELD[("key", 0x10)] = (100.0, False)
    bw._HELD[("button", "left")] = (110.0, False)
    freed = bw._watchdog_sweep(now=116.0)
    assert freed == ["key:16"]
    assert ("button", "left") in bw._HELD
    assert rec == [("key", 0x10, "up")]


# ---------------------------------------------------------------------------
# click_ex / scroll_smooth / type_text_paced
# ---------------------------------------------------------------------------
def test_click_ex_shift_click_wraps_click_in_modifier(rec):
    bw.click_ex(50, 60, modifiers="shift", coord_space="desktop")
    seq = [e for e in rec if e[0] != "move"]
    assert seq == [("key", 0x10, "down"), ("mouse", "ldown", 0), ("mouse", "lup", 0),
                   ("key", 0x10, "up")]


def test_click_ex_triple_click(rec):
    out = bw.click_ex(1, 1, clicks=3, coord_space="desktop")
    assert out["clicks"] == 3
    assert [e for e in rec if e[0] == "mouse"].count(("mouse", "ldown", 0)) == 3


def test_click_ex_releases_modifier_when_click_fails(rec, monkeypatch):
    real_send = bw._send

    def send(*evs):
        if evs and evs[0] == ("mouse", "ldown", 0):
            raise RuntimeError("injection failed")
        real_send(*evs)

    monkeypatch.setattr(bw, "_send", send)
    with pytest.raises(RuntimeError):
        bw.click_ex(1, 1, modifiers="ctrl", coord_space="desktop")
    assert rec[-1] == ("key", 0x11, "up")


def test_scroll_smooth_splits_into_sub_notch_deltas(rec):
    out = bw.scroll_smooth(amount=0.5, direction="down", delta_per_step=20)
    wheel = [e for e in rec if e[0] == "mouse"]
    assert out["wheel_delta"] == 60
    assert wheel == [("mouse", 0x800, -20)] * 3


def test_type_text_paced_sends_one_char_per_call(rec, monkeypatch):
    calls = []
    monkeypatch.setattr(bw, "_send", lambda *evs: calls.append(evs))
    out = bw.type_text_paced("a\nb")
    assert out["typed_chars"] == 3
    assert len(calls) == 3


# ---------------------------------------------------------------------------
# clipboard table codecs
# ---------------------------------------------------------------------------
def test_tsv_round_trip_with_quotes_tabs_and_newlines():
    rows = [["Item", "Qty", "Note"], ["Pens", 3, 'say "hi"'], ["a\tb", "=B2*2", "line1\nline2"]]
    text = wp.rows_to_tsv(rows)
    assert text.endswith("\r\n")
    assert wp.tsv_to_rows(text) == [[str(c) for c in r] for r in rows]


def test_tsv_parses_excel_style_copy():
    assert wp.tsv_to_rows("A\tB\r\n1\t2\r\n") == [["A", "B"], ["1", "2"]]
    assert wp.tsv_to_rows("") == []


def test_cf_html_offsets_point_at_the_fragment():
    frag = wp.rows_to_html([["<x>", "é"]])
    blob = wp.build_cf_html(frag)
    head = blob.decode("utf-8")
    vals = {k: int(head.split(f"{k}:")[1][:10]) for k in
            ("StartHTML", "EndHTML", "StartFragment", "EndFragment")}
    assert blob[vals["StartFragment"]:vals["EndFragment"]].decode("utf-8") == frag
    assert blob[vals["StartHTML"]:vals["EndHTML"]].decode("utf-8").startswith("<html>")
    assert vals["EndHTML"] == len(blob)
    assert "&lt;x&gt;" in frag


# ---------------------------------------------------------------------------
# platform patches + safety
# ---------------------------------------------------------------------------
def test_apply_patches_rebinds_platform_modules():
    import server_windows
    server_windows.apply_patches()
    from computer_use_mcp import apps, clipboard, windows, workspaces

    assert clipboard.copy is wp.clipboard_copy and clipboard.paste is wp.clipboard_paste
    assert windows.list_windows is wp.list_windows and windows.close is wp.close
    assert windows.activate is wp.activate and windows.set_state is wp.set_state
    assert apps.launch is wp.launch and apps.list_apps is wp.list_apps
    assert workspaces.list_workspaces is wp.list_workspaces


def test_list_windows_never_exposes_real_windows_as_agent_desktop(monkeypatch):
    monkeypatch.delenv("JARVIS_AGENT_INSANDBOX", raising=False)
    monkeypatch.setattr(wp, "_host_windows", lambda: [{"id": "win:1", "title": "Mail"}])
    assert wp.list_windows("sway") == []
    assert wp.list_windows("agent") == []
    assert wp.list_windows("all") == [{"id": "win:1", "title": "Mail"}]


def test_desktop_reset_refuses_on_host(monkeypatch):
    monkeypatch.delenv("JARVIS_AGENT_INSANDBOX", raising=False)
    closed = []
    monkeypatch.setattr(wp, "close", lambda wid: closed.append(wid))
    with pytest.raises(RuntimeError):
        tw.reset_agent_desktop()
    assert closed == []


def test_parse_window_id_and_app_matching():
    assert wp.parse_window_id("win:4242") == 4242
    assert wp.parse_window_id("0x10") == 16
    assert wp.parse_window_id("Excel") is None
    apps = [{"id": "A!Excel", "name": "Excel"}, {"id": "B", "name": "Excel Viewer Tools"},
            {"id": "C", "name": "Google Chrome"}]
    assert wp.match_app("excel", apps)["id"] == "A!Excel"
    assert wp.match_app("chrome", apps)["id"] == "C"
    assert wp.match_app("gogle chrome", apps)["id"] == "C"
    assert wp.match_app("zzz", apps) is None


def test_platform_calls_fail_clearly_off_windows():
    if wp.sys.platform == "win32":
        pytest.skip("real Windows")
    with pytest.raises(RuntimeError, match="requires Windows"):
        wp.clipboard_paste()


# ---------------------------------------------------------------------------
# UIA / Office helpers
# ---------------------------------------------------------------------------
def test_uia_helpers():
    assert win_uia.normalize_type("button") == "ButtonControl"
    assert win_uia.normalize_type("EditControl") == "EditControl"
    assert win_uia.normalize_type(None) is None
    assert win_uia.parse_eid("1234:0.3.2") == (1234, [0, 3, 2])
    assert win_uia.parse_eid("1234:") == (1234, [])
    with pytest.raises(ValueError):
        win_uia.parse_eid("x:1")
    if win_uia.sys.platform != "win32":
        with pytest.raises(RuntimeError, match="requires Windows"):
            win_uia.tree()


def test_office_value_helpers():
    assert win_office.as_2d(5.0) == [[5]]
    assert win_office.as_2d(((1.0, "a"), (2.5, None))) == [[1, "a"], [2.5, None]]
    assert win_office.pad_rows([["a"], ["b", "c"]]) == [["a", ""], ["b", "c"]]
    if win_office.sys.platform != "win32":
        with pytest.raises(RuntimeError, match="requires Windows"):
            win_office.excel_read("A1")
        assert win_office.installed("excel") is False


# ---------------------------------------------------------------------------
# waiting on the screen
# ---------------------------------------------------------------------------
def _fake_clock():
    t = {"now": 0.0}
    return (lambda: t["now"]), (lambda s: t.__setitem__("now", t["now"] + s))


def test_wait_change_detects_change():
    clock, sleep = _fake_clock()
    frames = iter([bytes(1024), bytes(1024), bytes([200]) * 1024])
    out = tw.wait_change(5, 0.5, None, "active", clock=clock, sleep=sleep,
                         thumb=lambda r, w: next(frames))
    assert out["changed"] is True


def test_wait_idle_waits_for_quiet_period():
    clock, sleep = _fake_clock()
    frames = iter([bytes([0]) * 1024, bytes([200]) * 1024] + [bytes([200]) * 1024] * 20)
    out = tw.wait_idle(1.0, 10, 0.5, None, "active", clock=clock, sleep=sleep,
                       thumb=lambda r, w: next(frames))
    assert out["idle"] is True and out["waited_s"] >= 1.0


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------
def test_register_adds_tools_overrides_and_plan_safe(monkeypatch):
    from mcp.server.fastmcp import FastMCP

    from computer_use_mcp import policy, tools_desktop

    monkeypatch.setattr(policy, "_PLAN_SAFE_TOOLS", policy._PLAN_SAFE_TOOLS)
    m = FastMCP("t")
    tools_desktop.register(m)
    old_reset = m._tool_manager._tools["desktop_reset"].fn
    tw.register(m)
    names = {t.name for t in asyncio.run(m.list_tools())}
    for n in ("mouse_drag_smooth", "mouse_click_ex", "mouse_down", "mouse_up", "key_down",
              "key_up", "input_release_all", "mouse_hover", "scroll_smooth",
              "type_text_paced", "wait_for_screen_change", "sheet_paste_table",
              "sheet_read_selection", "sheet_goto", "ui_tree", "ui_click", "office_status",
              "excel_read_range", "word_read", "ppt_add_slide"):
        assert n in names, n
    assert m._tool_manager._tools["desktop_reset"].fn is not old_reset
    assert tw.PLAN_SAFE <= policy._PLAN_SAFE_TOOLS
    assert "mouse_drag_smooth" not in policy._PLAN_SAFE_TOOLS
    schema = next(t for t in asyncio.run(m.list_tools())
                  if t.name == "mouse_drag_smooth").inputSchema
    assert schema["required"] == ["from_x", "from_y", "to_x", "to_y"]
    assert schema["properties"]["steps"]["default"] == 12
    assert schema["properties"]["step_delay_ms"]["default"] == 30
    assert schema["properties"]["coord_space"]["default"] == "desktop"


def test_mouse_drag_smooth_tool_reports_dragged_and_screen_changed(rec, monkeypatch):
    from mcp.server.fastmcp import FastMCP

    from computer_use_mcp import policy

    monkeypatch.setattr(policy, "_PLAN_SAFE_TOOLS", policy._PLAN_SAFE_TOOLS)
    monkeypatch.setattr(tw.selfheal, "run",
                        lambda tool, which, action, **k: {**action(),
                                                         "self_heal": {"screen_changed": True}})
    m = FastMCP("t")
    tw.register(m)
    res = m._tool_manager._tools["mouse_drag_smooth"].fn(0, 0, 50, 50)
    out = json.loads(res)
    assert out["dragged"] is True and out["screen_changed"] is True


def test_uia_describe_uses_generic_patterns(monkeypatch):
    """Pattern support is probed via Control.GetPattern(PatternId.X), which every
    control class has -- not the per-subclass GetInvokePattern() helpers."""
    pid = types.SimpleNamespace(InvokePattern=1, ValuePattern=2, TogglePattern=3,
                                ExpandCollapsePattern=4, SelectionItemPattern=5,
                                ScrollPattern=6, RangeValuePattern=7)
    monkeypatch.setitem(win_uia.sys.modules, "uiautomation", types.SimpleNamespace(PatternId=pid))
    rect = types.SimpleNamespace(left=10, top=20, right=110, bottom=50)

    class Custom:          # no GetInvokePattern / GetValuePattern helpers at all
        Name = "Save"
        ControlTypeName = "CustomControl"
        AutomationId = "save"
        BoundingRectangle = rect
        IsEnabled = True

        def GetPattern(self, p):
            return {1: object(), 2: types.SimpleNamespace(Value="draft")}.get(p)

    node = win_uia._describe(Custom(), "99:0.1", 2)
    assert node["patterns"] == ["invoke", "value"]
    assert node["value"] == "draft"
    assert node["rect"] == [10, 20, 100, 30]
    assert node["type"] == "Custom" and node["aid"] == "save"
