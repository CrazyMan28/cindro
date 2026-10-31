"""Real-Chromium integration tests for graphical (VM-console) browser control.

Headless Chromium runs the REAL unpacked extension, connected to the engine's
real ExtensionBridge; the MCP tool functions drive fixture pages that behave
like noVNC / Guacamole consoles (canvas framebuffers that log input in GUEST
coordinates). See browser_lab.py. Skipped when no Chromium binary is available
(set CINDRO_TEST_CHROMIUM to point at one).
"""

import json
import time

import pytest

from browser_lab import Lab, find_chromium

CHROMIUM = find_chromium()
pytestmark = pytest.mark.skipif(CHROMIUM is None, reason="no Chromium binary for the browser lab")


def _start(ext):
    lab = Lab(ext)
    try:
        return lab.start(CHROMIUM)
    except Exception as exc:  # pragma: no cover - environment problem, not a code bug
        lab.stop()
        pytest.skip(f"browser lab could not start: {exc}")


@pytest.fixture(scope="module", params=["cindro", "bridge"])
def lab(request):
    """The whole suite runs against BOTH shipped extensions: extension/ (the
    Cindro side-panel extension) and computer-use/extension/ (the standalone
    bridge). They load the same visual.js."""
    from computer_use_mcp import browser_visual as bv
    bv.store.clear()
    lb = _start(request.param)
    yield lb
    lb.stop()
    bv.store.clear()


def downs(log, kind="mousedown"):
    return [(e["gx"], e["gy"]) for e in log if e["type"] == kind]


def near(a, b, tol=1):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def inspect(lab, **kw):
    out = lab.tool("browser_visual_inspect", **kw)
    assert out[0].__class__.__name__ == "Image", out
    return json.loads(out[-1])


def test_novnc_console_detected_and_clicked_in_guest_coords(lab):
    tab = lab.open("novnc.html")
    meta = inspect(lab, tab_id=tab)
    assert meta["graphical"] and meta["primary_kind"] == "novnc"
    s1 = meta["surfaces"][0]
    assert s1["framebuffer"] == {"w": 1024, "h": 768}
    assert s1["rect_image"] == {"x": 40, "y": 30, "w": 800, "h": 600}
    # image coords: the surface center
    lab.call("browser_click_xy", x=440, y=330)
    log = lab.log(tab)
    assert near(downs(log)[0], (512, 384))
    assert all(e["trusted"] for e in log)                 # real input, not synthetic JS
    assert [e["type"] for e in log][:3] == ["mousemove", "mousedown", "mouseup"]
    # guest framebuffer coords
    lab.call("browser_click_xy", x=1000, y=700, coord_space="surface", surface="s1")
    assert near(downs(lab.log(tab))[0], (1000, 700))
    lab.call("browser_tab_close", tab_id=tab)


def test_verify_loop_sees_the_console_change(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    # the console's red "button" lives at guest (100..300, 100..160)
    out = lab.tool("browser_click_xy", x=200, y=130, coord_space="surface", verify=True,
                   settle_ms=300)
    res = json.loads(out[-1])
    assert out[0].__class__.__name__ == "Image"
    assert res["verify"]["screen_changed"] is True and res["verify"]["change_ratio"] > 0.002
    # clicking empty framebuffer changes nothing
    out = lab.tool("browser_click_xy", x=900, y=700, coord_space="surface", verify=True,
                   settle_ms=200)
    assert json.loads(out[-1])["verify"]["screen_changed"] is False
    lab.call("browser_tab_close", tab_id=tab)


def test_double_right_shift_click_drag_and_hold(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    lab.call("browser_click_xy", x=300, y=300, clicks=2)
    log = lab.log(tab)
    assert [e["detail"] for e in log if e["type"] == "mousedown"] == [1, 2]
    assert any(e["type"] == "dblclick" for e in log)
    lab.call("browser_click_xy", x=300, y=300, button="right")
    log = lab.log(tab)
    assert [e["button"] for e in log if e["type"] == "mousedown"] == [2]
    assert any(e["type"] == "contextmenu" for e in log)
    lab.call("browser_click_xy", x=300, y=300, modifiers="shift")
    log = lab.log(tab)
    assert [e["shift"] for e in log if e["type"] == "mousedown"] == [True]
    assert [e["key"] for e in log if e["type"] == "keydown"] == ["Shift"]   # the VM sees Shift
    # drag: press at A, moves with the button held, release at B
    lab.call("browser_drag_xy", x1=100, y1=100, x2=400, y2=300, steps=6)
    log = lab.log(tab)
    mv = [e for e in log if e["type"] == "mousemove" and e["buttons"] == 1]
    assert len(mv) >= 5
    assert near(downs(log)[0], ((100 - 40) * 1.28, (100 - 30) * 1.28))
    assert near(downs(log, "mouseup")[0], ((400 - 40) * 1.28, (300 - 30) * 1.28))
    # manual hold: down, move, up
    lab.call("browser_mouse_down", x=200, y=200)
    lab.call("browser_move_xy", x=250, y=260, steps=3)
    lab.call("browser_mouse_up")
    log = lab.log(tab)
    kinds = [e["type"] for e in log if e["type"] != "mousemove"]
    assert kinds == ["mousedown", "mouseup"]
    i_down = [e["type"] for e in log].index("mousedown")
    i_up = [e["type"] for e in log].index("mouseup")
    held_moves = [e for e in log[i_down:i_up] if e["type"] == "mousemove"]
    assert len(held_moves) >= 2 and all(e["buttons"] == 1 for e in held_moves)
    assert near(downs(log, "mouseup")[0], ((250 - 40) * 1.28, (260 - 30) * 1.28))
    lab.call("browser_tab_close", tab_id=tab)


def test_keyboard_shortcuts_and_typing_reach_the_console(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    lab.call("browser_click_xy", x=400, y=300)   # focus the console canvas
    meta = inspect(lab, tab_id=tab)
    assert meta["surfaces"][0]["focused"] is True
    lab.log(tab)
    lab.call("browser_key_press", keys="ctrl+alt+delete")
    log = lab.log(tab)
    assert [(e["type"], e["key"]) for e in log] == [
        ("keydown", "Control"), ("keydown", "Alt"), ("keydown", "Delete"),
        ("keyup", "Delete"), ("keyup", "Alt"), ("keyup", "Control")]
    dl = [e for e in log if e["key"] == "Delete"][0]
    assert dl["ctrl"] and dl["alt"] and dl["keyCode"] == 46 and dl["code"] == "Delete"
    lab.call("browser_key_press", keys="win+r")
    log = lab.log(tab)
    r = [e for e in log if e["key"] == "r" and e["type"] == "keydown"][0]
    assert r["meta"] and r["code"] == "KeyR"
    res = lab.call("browser_type_trusted", text="ipconfig /all", submit=True)
    assert res["mode"] == "keys"          # a focused canvas never gets insertText
    log = lab.log(tab)
    typed = "".join(e["key"] for e in log if e["type"] == "keydown" and len(e["key"]) == 1)
    assert typed == "ipconfig /all"
    assert [e["key"] for e in log if e["type"] == "keydown"][-1] == "Enter"
    slash = [e for e in log if e["type"] == "keydown" and e["key"] == "/"][0]
    assert slash["code"] == "Slash" and slash["keyCode"] == 191
    res = lab.call("browser_type_trusted", text='Pa$$w0rd!"')
    log = lab.log(tab)
    typed = "".join(e["key"] for e in log if e["type"] == "keydown" and len(e["key"]) == 1)
    assert typed == 'Pa$$w0rd!"'
    assert all(e["trusted"] for e in log)
    lab.call("browser_tab_close", tab_id=tab)


def test_scroll_wheel_notches(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    lab.call("browser_scroll_xy", x=400, y=300, direction="down", amount=3)
    wheels = [e for e in lab.log(tab) if e["type"] == "wheel"]
    assert [w["dy"] for w in wheels] == [100, 100, 100]
    lab.call("browser_scroll_xy", x=400, y=300, direction="up", amount=1)
    assert [w["dy"] for w in lab.log(tab) if w["type"] == "wheel"] == [-100]
    lab.call("browser_tab_close", tab_id=tab)


@pytest.mark.parametrize("page,origin", [
    ("frame_outer.html", (162, 102)),          # cross-origin iframe (OOPIF), border+padding
    ("nested.html", (222, 142)),               # main -> wrapper iframe -> cross-origin console
])
def test_iframe_offsets_are_composed(lab, page, origin):
    tab = lab.open(page)
    meta = inspect(lab, tab_id=tab)
    s1 = meta["surfaces"][0]
    assert s1["kind"] == "guacamole"
    assert s1["rect_image"] == {"x": origin[0], "y": origin[1], "w": 640, "h": 480}
    assert s1.get("frame_placement", "exact") == "exact"
    lab.call("browser_click_xy", x=origin[0] + 200, y=origin[1] + 130)
    assert near(downs(lab.log(tab))[0], (200, 130))
    lab.call("browser_click_xy", x=600, y=400, coord_space="surface")
    assert near(downs(lab.log(tab))[0], (600, 400))
    lab.call("browser_type_trusted", text="ok")
    assert "".join(e["key"] for e in lab.log(tab) if e["type"] == "keydown") == "ok"
    lab.call("browser_tab_close", tab_id=tab)


def test_css_transformed_iframe_and_letterboxed_canvas(lab):
    tab = lab.open("frame_outer_scaled.html")
    meta = inspect(lab, tab_id=tab)
    assert meta["surfaces"][0]["rect_image"]["w"] == 480        # scale(0.75)
    lab.call("browser_click_xy", x=320, y=240, coord_space="surface")
    assert near(downs(lab.log(tab))[0], (320, 240), tol=2)
    lab.call("browser_tab_close", tab_id=tab)

    tab = lab.open("letterbox.html")
    meta = inspect(lab, tab_id=tab)
    s1 = meta["surfaces"][0]
    # 1920x1080 in an 800x800 object-fit:contain box -> 800x450 band, 175px bars
    assert s1["rect_image"] == {"x": 100, "y": 225, "w": 800, "h": 450}
    lab.call("browser_click_xy", x=1919, y=1079, coord_space="surface")
    assert near(downs(lab.log(tab))[0], (1919, 1079), tol=3)
    lab.call("browser_click_xy", x=960, y=540, coord_space="surface")
    assert near(downs(lab.log(tab))[0], (960, 540), tol=3)
    lab.call("browser_tab_close", tab_id=tab)


def test_browser_zoom_and_hidpi_scaling(lab):
    tab = lab.open("novnc.html")
    lab.sw_eval(f"chrome.tabs.setZoom({tab}, 1.5).then(() => true)")
    time.sleep(0.4)
    meta = inspect(lab, tab_id=tab)
    assert meta["browser_zoom"] == 1.5 and abs(meta["image_px_per_css_px"] - 1.5) < 0.01
    s1 = meta["surfaces"][0]["rect_image"]
    assert (s1["x"], s1["y"]) == (60, 45)
    lab.call("browser_click_xy", x=60 + 300, y=45 + 225)          # guest (256,192)*1.5 css
    assert near(downs(lab.log(tab))[0], (256, 192))
    lab.sw_eval(f"chrome.tabs.setZoom({tab}, 1).then(() => true)")
    # Device pixel ratio 2 (HiDPI): the capture is 2x the CSS viewport.
    lab.call("browser_cdp", method="Emulation.setDeviceMetricsOverride", tab_id=tab,
             params_json=json.dumps({"width": 1100, "height": 700, "deviceScaleFactor": 2,
                                     "mobile": False}))
    meta = inspect(lab, tab_id=tab, max_width=4000, max_height=4000)
    assert meta["image"] == {"width": 2200, "height": 1400} and meta["device_pixel_ratio"] == 2
    lab.call("browser_click_xy", x=(40 + 400) * 2, y=(30 + 300) * 2)
    assert near(downs(lab.log(tab))[0], (512, 384))
    # The default max_width (1280) downscales the 2200px capture: still exact.
    meta = inspect(lab, tab_id=tab)
    k = meta["image_px_per_css_px"]
    assert meta["image"]["width"] == 1280 and abs(k - 1280 / 1100) < 0.01
    lab.call("browser_click_xy", x=440 * k, y=330 * k)
    assert near(downs(lab.log(tab))[0], (512, 384))
    lab.call("browser_tab_close", tab_id=tab)


def test_console_resize_is_detected_then_reinspect_recovers(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    lab.call("browser_cdp", method="Emulation.setDeviceMetricsOverride", tab_id=tab,
             params_json=json.dumps({"width": 900, "height": 650, "deviceScaleFactor": 1,
                                     "mobile": False}))
    res = lab.call("browser_click_xy", x=100, y=100)
    assert "viewport changed" in res["error"]
    assert lab.log(tab) == []                     # nothing was dispatched on a stale map
    meta = inspect(lab, tab_id=tab)
    assert meta["viewport_css"] == {"width": 900, "height": 650}
    lab.call("browser_click_xy", x=440, y=330)
    assert near(downs(lab.log(tab))[0], (512, 384))
    lab.call("browser_cdp", method="Emulation.clearDeviceMetricsOverride", tab_id=tab)
    lab.call("browser_tab_close", tab_id=tab)


def test_page_scroll_since_inspection_is_detected(lab):
    tab = lab.open("letterbox.html")       # its canvas overflows the viewport
    inspect(lab, tab_id=tab)
    lab.eval("document.documentElement.style.overflow='auto';"
             "document.body.style.overflow='auto'; scrollTo(0, 60); scrollY", tab)
    res = lab.call("browser_click_xy", x=500, y=450)
    assert "page scrolled" in res["error"]
    assert lab.log(tab) == []
    inspect(lab, tab_id=tab)
    lab.call("browser_click_xy", x=500, y=450 - 60)
    assert near(downs(lab.log(tab))[0], (960, 540), tol=3)
    lab.call("browser_tab_close", tab_id=tab)


def test_fullscreen_console(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    # Fullscreen needs a user gesture — a trusted CDP click provides one.
    lab.eval("document.getElementById('noVNC_canvas').addEventListener('mousedown', "
             "() => document.getElementById('noVNC_container').requestFullscreen(), {once: true})", tab)
    lab.call("browser_click_xy", x=600, y=500)
    time.sleep(0.6)
    meta = inspect(lab, tab_id=tab)
    assert meta["fullscreen"] is True
    lab.log(tab)
    s1 = meta["surfaces"][0]
    lab.call("browser_click_xy", x=s1["rect_image"]["x"] + 10, y=s1["rect_image"]["y"] + 10)
    assert len(downs(lab.log(tab))) == 1
    lab.eval("document.exitFullscreen()", tab)
    lab.call("browser_tab_close", tab_id=tab)


def test_zoomed_surface_crop_for_reading_console_text(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    meta = inspect(lab, surface="s1")
    assert meta["zoomed_region"] and meta["image_origin_css"] == {"x": 40.0, "y": 30.0}
    assert meta["image"]["width"] == 1280      # magnified from 800 css px
    # coordinates on the crop: its (0,0) is the console's top-left
    lab.call("browser_click_xy", x=meta["image"]["width"] / 2, y=meta["image"]["height"] / 2)
    assert near(downs(lab.log(tab))[0], (512, 384))
    lab.call("browser_tab_close", tab_id=tab)


def test_dom_pages_keep_working_and_insert_mode(lab):
    tab = lab.open("form.html")
    snap = lab.call("browser_snapshot", tab_id=tab)
    assert "graphical" not in snap and "INTERACTIVE" in snap["text"]
    meta = inspect(lab, tab_id=tab)
    assert meta["graphical"] is False
    lab.call("browser_click_xy", x=200, y=65)       # focus the input by pixel
    res = lab.call("browser_type_trusted", text="Ada Lovelace")
    assert res["mode"] == "insert"
    assert lab.eval("document.getElementById('name').value", tab) == "Ada Lovelace"
    # existing DOM tools still work alongside
    lab.call("browser_type", selector="#name", text="Grace")
    lab.call("browser_click", selector="#go")
    assert lab.eval("document.title", tab) == "clicked:Grace"
    lab.call("browser_click", selector="#go", trusted=True)
    shot = lab.tool("browser_screenshot", tab_id=tab)
    assert shot[0].__class__.__name__ == "Image"
    lab.call("browser_tab_close", tab_id=tab)


def test_snapshot_flags_console_pages(lab):
    tab = lab.open("novnc.html")
    snap = lab.call("browser_snapshot", tab_id=tab)
    assert snap["graphical"]["graphical"] and snap["graphical"]["primary_kind"] == "novnc"
    lab.call("browser_tab_close", tab_id=tab)


def test_two_tabs_stay_isolated(lab):
    a = lab.open("novnc.html")
    b = lab.open("letterbox.html")
    inspect(lab, tab_id=a)
    inspect(lab, tab_id=b)
    lab.call("browser_click_xy", x=440, y=330, tab_id=a)      # a's console center
    assert near(downs(lab.log(a))[0], (512, 384))
    assert downs(lab.log(b)) == []
    lab.call("browser_click_xy", x=500, y=450, tab_id=b)      # b's console center
    assert near(downs(lab.log(b))[0], (960, 540), tol=3)
    assert downs(lab.log(a)) == []
    lab.call("browser_tab_close", tab_id=a)
    lab.call("browser_tab_close", tab_id=b)


def test_extension_disconnect_and_recovery(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    lab.sw_eval("(() => { const s = ws; ws = null; s.close(); return true; })()")
    deadline = time.time() + 5
    while lab.bridge.connected and time.time() < deadline:
        time.sleep(0.05)
    res = lab.call("browser_click_xy", x=10, y=10)
    assert "not connected" in res["error"].lower()
    deadline = time.time() + 20                      # the extension reconnects by itself
    while not lab.bridge.connected and time.time() < deadline:
        time.sleep(0.1)
    assert lab.bridge.connected
    lab.call("browser_click_xy", x=440, y=330, tab_id=tab)
    assert near(downs(lab.log(tab))[0], (512, 384))
    lab.call("browser_tab_close", tab_id=tab)


def test_failed_sequence_releases_held_input(lab):
    tab = lab.open("novnc.html")
    inspect(lab, tab_id=tab)
    lab.call("browser_mouse_down", x=200, y=200)
    lab.log(tab)
    # a bad event mid-sequence makes Chrome reject it; held input must be freed
    bad = {"tabId": tab, "events": [
        {"method": "Input.dispatchKeyEvent", "params": {"type": "rawKeyDown", "key": "Shift",
                                                       "code": "ShiftLeft", "modifiers": 8,
                                                       "windowsVirtualKeyCode": 16}},
        {"method": "Input.dispatchMouseEvent", "params": {"type": "bogus", "x": 1, "y": 1}}],
        "releaseOnError": [
            {"method": "Input.dispatchMouseEvent", "params": {"type": "mouseReleased", "x": 200,
                                                             "y": 200, "button": "left", "buttons": 0,
                                                             "clickCount": 1}},
            {"method": "Input.dispatchKeyEvent", "params": {"type": "keyUp", "key": "Shift",
                                                           "code": "ShiftLeft", "modifiers": 0,
                                                           "windowsVirtualKeyCode": 16}}]}
    with pytest.raises(RuntimeError, match="released"):
        lab.run(lab.bridge.send_command("input.sequence", bad))
    log = lab.log(tab)
    assert [e["type"] for e in log if e["type"] != "mousemove"] == ["keydown", "mouseup", "keyup"]
    # and only Input.* methods are accepted
    with pytest.raises(RuntimeError, match="only dispatches Input"):
        lab.run(lab.bridge.send_command("input.sequence", {
            "tabId": tab, "events": [{"method": "Runtime.evaluate", "params": {"expression": "1"}}]}))
    lab.call("browser_input_release", tab_id=tab)
    lab.call("browser_tab_close", tab_id=tab)
