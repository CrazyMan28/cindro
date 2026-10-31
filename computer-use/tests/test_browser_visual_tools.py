"""The graphical browser MCP tools against a scripted fake extension bridge:
payload shape, coordinate resolution, held-input bookkeeping, verify, session
isolation via inspect_id, disconnect/old-extension errors, and the policy
hooks (plan-mode read-only allowlist, command scan of typed text)."""

import asyncio
import base64
import json

import pytest
from mcp.server.fastmcp import FastMCP

from computer_use_mcp import browser_visual as bv
from computer_use_mcp import policy, tools_browser, tools_browser_visual
from computer_use_mcp.browser_bridge import NOT_CONNECTED, BridgeNotConnected

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG fake").decode()


def _inspect_reply(tab=11, scale=1.0, vw=1280, vh=800, origin=(0, 0), img=None, change=None):
    img = img or (int(vw * scale), int(vh * scale))
    r = {"tabId": tab, "imageWidth": img[0], "imageHeight": img[1], "dataUrl": PNG,
         "mapping": {"originX": origin[0], "originY": origin[1],
                     "scaleX": img[0] / (vw - origin[0]) if origin[0] else scale,
                     "scaleY": img[1] / (vh - origin[1]) if origin[1] else scale},
         "viewport": {"width": vw, "height": vh}, "zoom": 1, "devicePixelRatio": 2,
         "fullscreen": False, "title": "VM", "url": "https://pve/",
         "frames": [{"frameId": 0, "href": "https://pve/", "innerW": vw, "innerH": vh,
                     "hasFocus": True, "active": {"tag": "CANVAS"},
                     "surfaces": [{"tag": "canvas", "kind": "novnc",
                                   "box": {"x": 40, "y": 30, "w": 800, "h": 600},
                                   "intrinsic": {"w": 1024, "h": 768}, "fit": "fill",
                                   "focused": True}]}]}
    if change is not None:
        r["changeRatio"] = change
    return r


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.replies = {}
        self.connected = True

    async def send_command(self, method, params=None, timeout=None):
        self.calls.append((method, params or {}, timeout))
        if not self.connected:
            raise BridgeNotConnected(NOT_CONNECTED)
        r = self.replies.get(method)
        if isinstance(r, Exception):
            raise r
        if callable(r):
            return r(params or {})
        if method == "input.sequence":
            out = {"tabId": params.get("tabId") or 11, "dispatched": len(params["events"])}
            if params.get("verify"):
                out["verify"] = _inspect_reply(tab=out["tabId"], change=0.05)
            return out
        return r

    def last(self, method):
        return [c for c in self.calls if c[0] == method][-1]


@pytest.fixture
def lab(monkeypatch):
    fb = FakeBridge()
    fb.replies["page.inspect"] = lambda p: _inspect_reply(tab=p.get("tabId") or 11)
    monkeypatch.setattr(tools_browser_visual, "bridge", fb)
    monkeypatch.setattr(tools_browser, "bridge", fb)
    bv.store.clear()
    mcp = FastMCP("t")
    tools_browser.register(mcp)

    def call(name, **kw):
        out = asyncio.run(mcp._tool_manager.get_tool(name).fn(**kw))
        if isinstance(out, list):
            return json.loads([o for o in out if isinstance(o, str)][-1]), out
        return json.loads(out), [out]

    fb.call = call
    yield fb
    bv.store.clear()


def test_all_graphical_tools_registered():
    mcp = FastMCP("t")
    tools_browser.register(mcp)
    names = set(mcp._tool_manager._tools)
    for t in ("browser_visual_inspect", "browser_click_xy", "browser_move_xy", "browser_drag_xy",
              "browser_scroll_xy", "browser_mouse_down", "browser_mouse_up", "browser_key_press",
              "browser_type_trusted", "browser_input_release",
              # existing DOM tools untouched
              "browser_snapshot", "browser_click", "browser_type", "browser_screenshot",
              "browser_cdp", "browser_eval", "browser_navigate"):
        assert t in names


def test_inspect_returns_image_and_metadata(lab):
    meta, out = lab.call("browser_visual_inspect", tab_id=11)
    assert out[0].__class__.__name__ == "Image"
    assert meta["graphical"] and meta["primary_kind"] == "novnc"
    assert meta["surfaces"][0]["rect_image"] == {"x": 40, "y": 30, "w": 800, "h": 600}
    assert meta["device_pixel_ratio"] == 2 and meta["inspect_id"].startswith("v")
    method, params, timeout = lab.last("page.inspect")
    assert params["maxWidth"] == 1280 and params["tabId"] == 11 and timeout == 45


def test_inspect_surface_zoom_sends_css_clip(lab):
    lab.call("browser_visual_inspect", tab_id=11)
    lab.call("browser_visual_inspect", surface="s1")
    _, params, _ = lab.last("page.inspect")
    assert params["clip"] == {"x": 40, "y": 30, "w": 800, "h": 600}
    assert params["upscale"] is True and params["tabId"] == 11


def test_inspect_region_in_previous_image_coords(lab):
    lab.replies["page.inspect"] = lambda p: _inspect_reply(scale=0.5)
    lab.call("browser_visual_inspect", tab_id=11, max_width=640)
    lab.call("browser_visual_inspect", region_x=10, region_y=20, region_w=100, region_h=50)
    _, params, _ = lab.last("page.inspect")
    assert params["clip"] == {"x": 20, "y": 40, "w": 200, "h": 100}


def test_inspect_errors_are_json(lab):
    meta, _ = lab.call("browser_visual_inspect", surface="s1")
    assert "inspect the tab once" in meta["error"]
    meta, _ = lab.call("browser_visual_inspect", format="gif")
    assert "format" in meta["error"]


def test_click_maps_image_coords_and_sends_trusted_sequence(lab):
    lab.replies["page.inspect"] = lambda p: _inspect_reply(scale=0.5)  # 640x400 image
    lab.call("browser_visual_inspect", tab_id=11)
    res, _ = lab.call("browser_click_xy", x=100, y=50)
    assert res["ok"] and res["clicked"]["point_css"] == [200, 100]
    _, params, _ = lab.last("input.sequence")
    assert params["tabId"] == 11
    assert params["expectViewport"] == {"width": 1280, "height": 800}
    assert [e["params"]["type"] for e in params["events"]] == [
        "mouseMoved", "mousePressed", "mouseReleased"]
    assert params["pointer"] == {"x": 200, "y": 100}
    assert any(e["params"]["type"] == "mouseReleased" for e in params["releaseOnError"])


def test_click_in_guest_framebuffer_coords_with_modifiers(lab):
    lab.call("browser_visual_inspect", tab_id=11)
    res, _ = lab.call("browser_click_xy", x=512, y=384, coord_space="surface", modifiers="shift",
                      button="right")
    assert res["clicked"]["point_css"] == [440, 330]
    evs = lab.last("input.sequence")[1]["events"]
    assert evs[0]["params"]["key"] == "Shift" and evs[-1]["params"]["type"] == "keyUp"
    pressed = [e for e in evs if e["params"]["type"] == "mousePressed"][0]["params"]
    assert pressed["button"] == "right" and pressed["modifiers"] == 8


def test_click_without_inspection_requires_one_or_viewport_space(lab):
    res, _ = lab.call("browser_click_xy", x=1, y=1)
    assert "browser_visual_inspect first" in res["error"]
    res, _ = lab.call("browser_click_xy", x=5, y=6, coord_space="viewport")
    assert res["ok"] and lab.last("input.sequence")[1]["expectViewport"] is None


def test_verify_returns_new_image_and_rebinds_mapping(lab):
    lab.call("browser_visual_inspect", tab_id=11)
    first = bv.store.get(None, 11).inspect_id
    res, out = lab.call("browser_click_xy", x=10, y=10, verify=True, settle_ms=250)
    assert out[0].__class__.__name__ == "Image"
    v = res["verify"]
    assert v["screen_changed"] is True and v["change_ratio"] == 0.05
    assert v["inspect_id"] != first and bv.store.get(None, 11).inspect_id == v["inspect_id"]
    _, params, timeout = lab.last("input.sequence")
    assert params["verify"]["settleMs"] == 250 and params["verify"]["maxWidth"] == 1280
    assert timeout > 30


def test_inspect_id_pins_an_agent_to_its_own_image(lab):
    # agent A inspects at full size; agent B zooms the same tab afterwards.
    lab.call("browser_visual_inspect", tab_id=11)
    a_id = bv.store.get(None, 11).inspect_id
    lab.replies["page.inspect"] = lambda p: _inspect_reply(scale=2.0)
    lab.call("browser_visual_inspect", tab_id=11, max_width=4000)
    res, _ = lab.call("browser_click_xy", x=100, y=100, inspect_id=a_id)
    assert res["clicked"]["point_css"] == [100, 100]       # A's mapping (1:1)
    res, _ = lab.call("browser_click_xy", x=100, y=100)
    assert res["clicked"]["point_css"] == [50, 50]         # newest (2x)
    res, _ = lab.call("browser_click_xy", x=1, y=1, inspect_id=a_id, tab_id=99)
    assert "belongs to tab" in res["error"]


def test_tabs_keep_separate_mappings(lab):
    lab.replies["page.inspect"] = lambda p: _inspect_reply(tab=p["tabId"],
                                                           scale=1.0 if p["tabId"] == 1 else 0.5)
    lab.call("browser_visual_inspect", tab_id=1)
    lab.call("browser_visual_inspect", tab_id=2)
    assert lab.call("browser_click_xy", x=100, y=100, tab_id=1)[0]["clicked"]["point_css"] == [100, 100]
    assert lab.call("browser_click_xy", x=100, y=100, tab_id=2)[0]["clicked"]["point_css"] == [200, 200]
    # no tab_id -> the most recently inspected tab
    lab.call("browser_click_xy", x=1, y=1)
    assert lab.last("input.sequence")[1]["tabId"] == 2


def test_drag_scroll_move_payloads(lab):
    lab.call("browser_visual_inspect", tab_id=11)
    res, _ = lab.call("browser_drag_xy", x1=10, y1=10, x2=110, y2=60, steps=5, hold_ms=200)
    evs = lab.last("input.sequence")[1]["events"]
    assert res["dragged_css"] == [[10, 10], [110, 60]]
    assert [e["params"]["type"] for e in evs].count("mouseMoved") == 6
    lab.call("browser_scroll_xy", x=300, y=300, direction="down", amount=4)
    wheels = [e for e in lab.last("input.sequence")[1]["events"] if e["params"]["type"] == "mouseWheel"]
    assert len(wheels) == 4
    lab.call("browser_move_xy", x=20, y=20, steps=4)
    moves = lab.last("input.sequence")[1]["events"]
    assert len(moves) == 4 and moves[0]["params"]["x"] != 20   # glides from the last point


def test_mouse_down_holds_until_up_and_release_recovers(lab):
    lab.call("browser_visual_inspect", tab_id=11)
    lab.call("browser_mouse_down", x=10, y=10)
    assert bv.store.held[11] == 1
    lab.call("browser_move_xy", x=50, y=50, steps=2)
    assert all(e["params"]["buttons"] == 1 for e in lab.last("input.sequence")[1]["events"])
    res, _ = lab.call("browser_mouse_up")
    assert res["released"] == "left" and bv.store.held[11] == 0
    assert lab.last("input.sequence")[1]["events"][0]["params"]["x"] == 50
    lab.call("browser_mouse_down", x=10, y=10, button="middle")
    res, _ = lab.call("browser_input_release")
    assert res["released"] == "all" and 11 not in bv.store.held
    kinds = [e["params"]["type"] for e in lab.last("input.sequence")[1]["events"]]
    assert "mouseReleased" in kinds and kinds.count("keyUp") == 4


def test_mouse_up_without_known_position(lab):
    res, _ = lab.call("browser_mouse_up", tab_id=5)
    assert "pass x and y" in res["error"]


def test_key_press_sequence_and_repeat(lab):
    res, _ = lab.call("browser_key_press", keys="ctrl+alt+delete enter", repeat=2, tab_id=3)
    evs = lab.last("input.sequence")[1]["events"]
    assert res["pressed"] == ["ctrl+alt+delete", "enter"] and len(evs) == 2 * (6 + 2)
    assert evs[6].get("delayMs") == 30   # gap between presses
    res, _ = lab.call("browser_key_press", keys="hyperdrive", tab_id=3)
    assert "unknown key" in res["error"]


def test_type_auto_picks_insert_for_plain_field_and_keys_for_console(lab):
    lab.replies["page.focus"] = {"tabId": 3, "frames": [
        {"frameId": 0, "hasFocus": True, "active": {"tag": "INPUT", "plainText": True}}]}
    res, _ = lab.call("browser_type_trusted", text="hello", tab_id=3)
    assert res["mode"] == "insert"
    assert lab.last("input.sequence")[1]["events"] == [
        {"method": "Input.insertText", "params": {"text": "hello"}}]
    lab.replies["page.focus"] = {"tabId": 3, "frames": [
        {"frameId": 0, "hasFocus": True, "active": {"tag": "CANVAS"}}]}
    res, _ = lab.call("browser_type_trusted", text="ipconfig /all", submit=True, tab_id=3)
    evs = lab.last("input.sequence")[1]["events"]
    assert res["mode"] == "keys" and res["submitted"]
    assert evs[-2]["params"]["key"] == "Enter"
    # focus probe unavailable (old extension) -> keys, the mode that always lands
    lab.replies["page.focus"] = RuntimeError("Extension error for page.focus: unknown method page.focus")
    assert lab.call("browser_type_trusted", text="x", tab_id=3)[0]["mode"] == "keys"


def test_type_with_focus_click_first(lab):
    lab.call("browser_visual_inspect", tab_id=11)
    res, _ = lab.call("browser_type_trusted", text="ab", x=100, y=100)
    evs = lab.last("input.sequence")[1]["events"]
    assert res["mode"] == "keys"
    assert [e["params"]["type"] for e in evs[:3]] == ["mouseMoved", "mousePressed", "mouseReleased"]
    assert evs[3]["delayMs"] >= 120


def test_type_rejects_huge_text(lab):
    res, _ = lab.call("browser_type_trusted", text="x" * 20001)
    assert "characters" in res["error"]


def test_old_extension_gets_upgrade_hint(lab):
    lab.replies["page.inspect"] = RuntimeError(
        "Extension error for page.inspect: unknown method page.inspect")
    res, _ = lab.call("browser_visual_inspect")
    assert "chrome://extensions" in res["error"] and "0.6.0" in res["error"]


def test_disconnected_extension_errors_cleanly_then_recovers(lab):
    lab.connected = False
    res, _ = lab.call("browser_key_press", keys="enter")
    assert "not connected" in res["error"].lower()
    res, _ = lab.call("browser_visual_inspect")
    assert "not connected" in res["error"].lower()
    lab.connected = True
    res, _ = lab.call("browser_key_press", keys="enter")
    assert res["ok"]


def test_extension_side_failure_is_reported(lab):
    lab.call("browser_visual_inspect", tab_id=11)
    lab.replies["input.sequence"] = RuntimeError(
        "Extension error for input.sequence: viewport changed since the inspection "
        "(1280x800 -> 1000x700) — call browser_visual_inspect again")
    res, _ = lab.call("browser_click_xy", x=1, y=1)
    assert "viewport changed" in res["error"]


def test_snapshot_gets_graphical_hint_only_for_consoles(lab):
    lab.replies["page.snapshot"] = {"gen": 1, "text": "PAGE: x"}
    lab.replies["page.surfaces"] = {"tabId": 1, "viewport": {"width": 1280, "height": 800},
                                    "frames": _inspect_reply()["frames"]}
    res, _ = lab.call("browser_snapshot")
    assert res["graphical"]["graphical"] and res["graphical"]["primary_kind"] == "novnc"
    assert res["text"] == "PAGE: x"
    lab.replies["page.surfaces"] = {"tabId": 1, "viewport": {"width": 1280, "height": 800},
                                    "frames": [{"frameId": 0, "innerW": 1280, "innerH": 800}]}
    res, _ = lab.call("browser_snapshot")
    assert "graphical" not in res
    # an old extension without page.surfaces must not break snapshots
    lab.replies["page.surfaces"] = RuntimeError("unknown method page.surfaces")
    res, _ = lab.call("browser_snapshot")
    assert res == {"gen": 1, "text": "PAGE: x"}


def test_policy_inspect_is_plan_safe_but_actions_are_not():
    assert "browser_visual_inspect" in policy._PLAN_SAFE_TOOLS
    for t in ("browser_click_xy", "browser_type_trusted", "browser_key_press", "browser_drag_xy"):
        assert t not in policy._PLAN_SAFE_TOOLS


def test_typed_vm_commands_go_through_command_scanner(monkeypatch):
    asked = []
    monkeypatch.setattr(policy.ask_bus, "ask", lambda q, opts, timeout=0: asked.append(q) or {"answer": "Deny"})
    monkeypatch.setattr(policy, "_log_cmd", lambda *a, **k: None)
    with pytest.raises(PermissionError, match="blocked by scanner"):
        policy._scan_command("browser_type_trusted", {"text": "rm -rf / --no-preserve-root\n"})
    assert asked and "rm -rf" in asked[0]
    policy._scan_command("browser_type_trusted", {"text": "ipconfig /all\n"})  # benign: no ask
    assert len(asked) == 1
