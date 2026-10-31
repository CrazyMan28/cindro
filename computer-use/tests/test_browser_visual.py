"""Pure logic behind the graphical browser tools (browser_visual.py): coordinate
mapping (DPR/zoom/crop), frame + letterbox composition, and the exact CDP
Input.* sequences for mouse/keyboard. No browser needed."""

import math

import pytest

from computer_use_mcp import browser_visual as bv


def _insp(**kw):
    base = dict(inspect_id="v1", tab_id=7, image_w=1280, image_h=800, origin_x=0.0,
                origin_y=0.0, scale_x=1.0, scale_y=1.0, viewport_w=1280.0, viewport_h=800.0)
    base.update(kw)
    return bv.Inspection(**base)


def _keys(evs):
    return [(e["params"]["type"], e["params"]["key"], e["params"]["modifiers"]) for e in evs]


# ---------------------------------------------------------------- mapping

def test_identity_mapping_round_trips():
    i = _insp()
    assert i.image_to_css(100, 200) == (100, 200)
    assert i.css_to_image(100, 200) == (100, 200)


def test_downscaled_hidpi_image_maps_to_css():
    # 2560x1600 device px (DPR 2) downscaled to 1280x800 -> 1 image px == 1 css px
    i = _insp(image_w=1280, image_h=800, scale_x=1280 / 1280, scale_y=1.0)
    assert i.image_to_css(640, 400) == (640, 400)
    # Browser zoom 150%: viewport is 853 css wide but image 1280 -> 1.5 img px/css
    z = _insp(viewport_w=853.3, viewport_h=533.3, scale_x=1.5, scale_y=1.5)
    assert z.image_to_css(150, 300) == pytest.approx((100, 200))


def test_zoomed_crop_mapping_includes_origin():
    # A 400x300 css region at (40,30) magnified 2x into an 800x600 image.
    i = _insp(image_w=800, image_h=600, origin_x=40, origin_y=30, scale_x=2, scale_y=2)
    assert i.image_to_css(0, 0) == (40, 30)
    assert i.image_to_css(400, 300) == (240, 180)
    assert i.css_rect_to_image({"x": 40, "y": 30, "w": 100, "h": 50}) == {
        "x": 0, "y": 0, "w": 200, "h": 100}


@pytest.mark.parametrize("pt", [(-5, 10), (10, 900), (1300, 1)])
def test_outside_image_rejected(pt):
    with pytest.raises(ValueError, match="outside the inspected image"):
        _insp().image_to_css(*pt)


@pytest.mark.parametrize("bad", [math.nan, math.inf, None, "3"])
def test_non_finite_rejected(bad):
    with pytest.raises(ValueError):
        _insp().image_to_css(bad, 1)


def test_resolve_point_spaces_and_viewport_guard():
    i = _insp(image_w=640, image_h=400, scale_x=0.5, scale_y=0.5)
    assert bv.resolve_point(i, 100, 100, "image") == (200, 200)
    assert bv.resolve_point(i, 100, 100, "screenshot") == (200, 200)
    assert bv.resolve_point(None, 5, 6, "viewport") == (5, 6)
    with pytest.raises(ValueError, match="browser_visual_inspect first"):
        bv.resolve_point(None, 5, 6, "image")
    with pytest.raises(ValueError, match="outside the visible viewport"):
        bv.resolve_point(i, 2000, 10, "css")
    with pytest.raises(ValueError, match="coord_space"):
        bv.resolve_point(i, 1, 1, "desktop")


def test_resolve_point_rounds_to_nearest_css_pixel():
    i = _insp(scale_x=3, scale_y=3, image_w=3000, image_h=2000)
    assert bv.resolve_point(i, 5, 4, "image") == (2.0, 1.0)  # 1.67 -> 2, 1.33 -> 1
    h = _insp(scale_x=2, scale_y=2, image_w=3000, image_h=2000)
    assert bv.resolve_point(h, 81, 83, "image") == (41.0, 42.0)  # 40.5 -> 41, not 40


def test_surface_point_targets_guest_pixel_centers_on_fractional_rects():
    # 1920x1080 letterboxed into 800x450 at a fractional offset
    s = {"id": "s1", "framebuffer": {"w": 1920, "h": 1080},
         "content_css": {"x": 100.3, "y": 225.6, "w": 800, "h": 450}}
    x, y = bv.surface_to_css(s, 0, 0)
    assert (x, y) == (101, 226)            # never left/above the drawn rect
    x, y = bv.surface_to_css(s, 1919, 1079)
    assert (x, y) == (900, 675)            # ceil(900.3)-1, ceil(675.6)-1
    with pytest.raises(ValueError, match="isn't located"):
        bv.surface_to_css(dict(s, content_css=None), 1, 1)


def test_surface_space_maps_guest_framebuffer():
    s = {"id": "s1", "framebuffer": {"w": 1024, "h": 768},
         "content_css": {"x": 40, "y": 30, "w": 800, "h": 600}}
    i = _insp(surfaces=[s])
    assert bv.resolve_point(i, 0, 0, "surface", "s1") == (40, 30)
    assert bv.resolve_point(i, 512, 384, "surface") == (440, 330)
    # the last guest pixel stays INSIDE the canvas (840/630 would hit-test outside)
    assert bv.resolve_point(i, 1023, 767, "guest") == (839, 629)
    assert bv.resolve_point(i, 1024, 768, "guest") == (839, 629)
    with pytest.raises(ValueError, match="outside surface"):
        bv.resolve_point(i, 2000, 10, "surface")
    with pytest.raises(ValueError, match="unknown surface"):
        bv.resolve_point(i, 1, 1, "surface", "s9")
    with pytest.raises(ValueError, match="no graphical surface"):
        bv.resolve_point(_insp(), 1, 1, "surface")


# ---------------------------------------------------------------- letterbox / frames

def test_object_fit_contain_letterboxes_wide_framebuffer():
    r = bv.object_fit_rect({"x": 100, "y": 50, "w": 800, "h": 800}, 1920, 1080, "contain")
    assert r == pytest.approx({"x": 100, "y": 225, "w": 800, "h": 450})  # 50 + (800-450)/2


def test_object_fit_variants():
    box = {"x": 0, "y": 0, "w": 400, "h": 400}
    assert bv.object_fit_rect(box, 800, 400, "fill") == box
    assert bv.object_fit_rect(box, 800, 400, "cover") == pytest.approx(
        {"x": -200, "y": 0, "w": 800, "h": 400})
    assert bv.object_fit_rect(box, 100, 100, "none") == pytest.approx(
        {"x": 150, "y": 150, "w": 100, "h": 100})
    assert bv.object_fit_rect(box, 100, 100, "scale-down") == pytest.approx(
        {"x": 150, "y": 150, "w": 100, "h": 100})
    assert bv.object_fit_rect(box, 800, 400, "contain", "0% 0%") == pytest.approx(
        {"x": 0, "y": 0, "w": 400, "h": 200})
    assert bv.object_fit_rect(box, 800, 400, "contain", "left bottom") == pytest.approx(
        {"x": 0, "y": 200, "w": 400, "h": 200})
    assert bv.object_fit_rect(box, 0, 0, "contain") == box  # unknown intrinsic size


def _frames_nested(scale=1.0):
    return [
        {"frameId": 0, "href": "https://portal/", "innerW": 1280, "innerH": 800,
         "iframes": [{"src": "https://portal/wrap.html", "x": 60, "y": 40, "w": 1000, "h": 700,
                      "sx": 1, "sy": 1}]},
        {"frameId": 5, "href": "https://portal/wrap.html", "innerW": 1000, "innerH": 700,
         "iframes": [{"src": "https://vm.example/console#x", "x": 162, "y": 102, "w": 640,
                      "h": 480, "sx": scale, "sy": scale}]},
        {"frameId": 9, "href": "https://vm.example/console", "innerW": 640, "innerH": 480,
         "surfaces": [{"tag": "canvas", "kind": "guacamole", "box": {"x": 0, "y": 0, "w": 640, "h": 480},
                       "intrinsic": {"w": 1280, "h": 960}, "fit": "fill", "focused": True}]},
    ]


def test_compose_frames_chains_offsets_and_scale():
    off = bv.compose_frames(_frames_nested(scale=0.75))
    assert off[0]["confidence"] == "exact"
    assert off[5] == {"x": 60, "y": 40, "sx": 1, "sy": 1, "confidence": "exact"}
    assert off[9]["x"] == 222 and off[9]["y"] == 142
    assert off[9]["sx"] == 0.75 and off[9]["confidence"] == "exact"  # fragment ignored


def test_compose_surfaces_places_nested_canvas_in_main_frame():
    surfaces = bv.compose_surfaces(_frames_nested(), 1280, 800)
    assert len(surfaces) == 1
    s = surfaces[0]
    assert s["id"] == "s1" and s["kind"] == "guacamole" and s["focused"]
    assert s["content_css"] == {"x": 222, "y": 142, "w": 640, "h": 480}
    i = _insp(surfaces=surfaces)
    # guest (640,480) of a 1280x960 framebuffer is the canvas center
    assert bv.resolve_point(i, 640, 480, "surface") == (542, 382)


def test_compose_matches_by_size_when_url_differs_and_reports_unplaced():
    frames = [
        {"frameId": 0, "href": "a", "innerW": 800, "innerH": 600,
         "iframes": [{"src": "about:blank", "x": 10, "y": 20, "w": 300, "h": 200}]},
        {"frameId": 3, "href": "https://other/redirected", "innerW": 300, "innerH": 200},
        {"frameId": 4, "href": "https://orphan/", "innerW": 50, "innerH": 50,
         "surfaces": [{"tag": "canvas", "box": {"x": 0, "y": 0, "w": 50, "h": 50}}]},
    ]
    off = bv.compose_frames(frames)
    assert off[3]["confidence"] == "size" and off[3]["x"] == 10
    assert off[4]["confidence"] == "none"
    s = bv.compose_surfaces(frames, 800, 600)
    assert s[0]["content_css"] is None and "note" in s[0]


def test_offscreen_surfaces_dropped_and_sorted_by_visible_area():
    frames = [{"frameId": 0, "href": "x", "innerW": 1000, "innerH": 700, "surfaces": [
        {"tag": "canvas", "kind": "canvas", "box": {"x": 0, "y": 0, "w": 100, "h": 100}},
        {"tag": "video", "kind": "remote-video", "box": {"x": 0, "y": 100, "w": 900, "h": 500}},
        {"tag": "canvas", "kind": "canvas", "box": {"x": 0, "y": 2000, "w": 300, "h": 300}},
    ]}]
    s = bv.compose_surfaces(frames, 1000, 700)
    assert [x["kind"] for x in s] == ["remote-video", "canvas"]
    assert [x["id"] for x in s] == ["s1", "s2"]
    verdict = bv.assess_graphical(s, 1000, 700)
    assert verdict["graphical"] and verdict["primary_kind"] == "remote-video"
    assert "browser_click_xy" in verdict["hint"]


def test_small_canvas_page_is_not_graphical():
    frames = [{"frameId": 0, "href": "x", "innerW": 1000, "innerH": 700, "surfaces": [
        {"tag": "canvas", "kind": "canvas", "box": {"x": 0, "y": 0, "w": 120, "h": 60}}]}]
    s = bv.compose_surfaces(frames, 1000, 700)
    assert bv.assess_graphical(s, 1000, 700) == {"graphical": False}


# ---------------------------------------------------------------- keyboard

def test_key_names_and_aliases():
    assert bv.key_def("Enter").key == "Enter" and bv.key_def("return").text == "\r"
    assert bv.key_def("win").key == "Meta" and bv.key_def("super").code == "MetaLeft"
    assert bv.key_def("esc").key_code == 27
    assert bv.key_def("F12").key_code == 123
    assert bv.key_def("pgdn").key == "PageDown"
    assert bv.key_def("kp5").code == "Numpad5" and bv.key_def("kp5").location == 3
    q = bv.key_def("?")
    assert (q.code, q.key_code, q.shift) == ("Slash", 191, True)
    with pytest.raises(ValueError, match="unknown key"):
        bv.key_def("hyperdrive")


def test_ctrl_alt_delete_sequence():
    evs = bv.combo_events("ctrl+alt+delete")
    assert _keys(evs) == [
        ("rawKeyDown", "Control", 2),
        ("rawKeyDown", "Alt", 3),
        ("rawKeyDown", "Delete", 3),
        ("keyUp", "Delete", 3),
        ("keyUp", "Alt", 2),
        ("keyUp", "Control", 0),
    ]
    assert all(e["method"] == "Input.dispatchKeyEvent" for e in evs)
    assert evs[2]["params"]["windowsVirtualKeyCode"] == 46


def test_command_shortcuts_carry_no_text_but_plain_keys_do():
    ctrl_c = bv.combo_events("ctrl+c")
    down = [e for e in ctrl_c if e["params"]["key"] == "c"][0]["params"]
    assert down["type"] == "rawKeyDown" and "text" not in down
    assert down["code"] == "KeyC" and down["windowsVirtualKeyCode"] == 67
    a = bv.combo_events("a")[0]["params"]
    assert a["type"] == "keyDown" and a["text"] == "a"


def test_shift_letter_reports_uppercase_and_ctrl_uppercase_is_lowercase():
    evs = bv.combo_events("shift+a")
    main = evs[1]["params"]
    assert main["key"] == "A" and main["text"] == "A" and main["modifiers"] == 8
    assert main["unmodifiedText"] == "a"
    # 'ctrl+C' means ctrl+c — no surprise shift
    assert [k for _, k, _ in _keys(bv.combo_events("ctrl+C"))] == ["Control", "c", "c", "Control"]


def test_literal_plus_and_win_r():
    evs = bv.combo_events("ctrl++")
    plus = [e["params"] for e in evs if e["params"]["key"] == "+"][0]
    assert plus["code"] == "Equal" and plus["modifiers"] == 2 | 8  # '+' is shift+= on US
    assert [k for _, k, _ in _keys(bv.combo_events("win+r"))] == ["Meta", "r", "r", "Meta"]


def test_combo_rejects_non_modifier_chords():
    with pytest.raises(ValueError, match="only the LAST key"):
        bv.parse_combo("a+b")
    with pytest.raises(ValueError):
        bv.parse_combo("")


def test_hold_ms_delays_release():
    evs = bv.combo_events("f2", hold_ms=500)
    assert evs[-1]["params"]["type"] == "keyUp" and evs[-1]["delayMs"] == 500


def test_key_sequence_splits_on_whitespace():
    assert bv.parse_key_sequence(" ctrl+a  ctrl+c ") == ["ctrl+a", "ctrl+c"]
    with pytest.raises(ValueError):
        bv.parse_key_sequence("   ")


def test_text_events_type_shifted_symbols_newlines_and_unicode():
    evs = bv.text_events("Hi!\né", delay_ms=7)
    downs = [e["params"] for e in evs if e["params"]["type"] in ("keyDown", "rawKeyDown")]
    assert [d["key"] for d in downs] == ["Shift", "H", "i", "Shift", "!", "Enter", "é"]
    bang = [d for d in downs if d["key"] == "!"][0]
    assert bang["code"] == "Digit1" and bang["modifiers"] == 8 and bang["unmodifiedText"] == "1"
    assert [d for d in downs if d["key"] == "é"][0] == {
        "type": "keyDown", "modifiers": 0, "key": "é", "code": "",
        "windowsVirtualKeyCode": 0, "nativeVirtualKeyCode": 0, "text": "é",
        "unmodifiedText": "é"}
    # delay before each character after the first; Shift is released every time
    assert evs[0].get("delayMs") is None
    assert sum(1 for e in evs if e.get("delayMs") == 7) == 4
    ups = [e["params"]["key"] for e in evs if e["params"]["type"] == "keyUp"]
    assert ups.count("Shift") == 2


def test_text_crlf_normalized_and_tab():
    evs = bv.text_events("a\r\nb\tc", 0)
    keys = [e["params"]["key"] for e in evs if e["params"]["type"] != "keyUp"]
    assert keys == ["a", "Enter", "b", "Tab", "c"]


def test_insert_text_event():
    assert bv.insert_text_events("hello") == [
        {"method": "Input.insertText", "params": {"text": "hello"}}]


def test_modifier_names_events_round_trip():
    down, mask = bv.modifier_names_events("ctrl+shift", True)
    up, end = bv.modifier_names_events("ctrl+shift", False, mask)
    assert mask == 10 and end == 0
    assert _keys(down) == [("rawKeyDown", "Control", 2), ("rawKeyDown", "Shift", 10)]
    assert _keys(up) == [("keyUp", "Shift", 2), ("keyUp", "Control", 0)]
    with pytest.raises(ValueError, match="not a modifier"):
        bv.modifier_names_events("shift+x", True)
    assert bv.modifier_names_events("", True) == ([], 0)


# ---------------------------------------------------------------- mouse

def _mice(evs):
    return [(e["params"]["type"], e["params"].get("button"), e["params"].get("buttons"),
             e["params"].get("clickCount")) for e in evs]


def test_click_moves_first_then_press_release():
    evs = bv.click_events(10, 20, "left", 1)
    assert _mice(evs) == [("mouseMoved", "none", 0, None),
                          ("mousePressed", "left", 1, 1),
                          ("mouseReleased", "left", 0, 1)]
    assert all(e["params"]["x"] == 10 and e["params"]["y"] == 20 for e in evs)


def test_double_and_right_click():
    d = bv.click_events(1, 1, "left", 2)
    assert [c for *_, c in _mice(d)] == [None, 1, 1, 2, 2]
    r = bv.click_events(1, 1, "secondary", 1)
    assert _mice(r)[1] == ("mousePressed", "right", 2, 1)
    assert len(bv.click_events(1, 1, "left", 99)) == 7  # capped at triple
    with pytest.raises(ValueError, match="button"):
        bv.click_events(1, 1, "thumb")


def test_drag_holds_button_through_every_move():
    evs = bv.drag_events(0, 0, 100, 50, steps=4, hold_ms=250)
    kinds = [e["params"]["type"] for e in evs]
    assert kinds == ["mouseMoved", "mousePressed"] + ["mouseMoved"] * 4 + ["mouseReleased"]
    moves = [e["params"] for e in evs[2:-1]]
    assert all(m["buttons"] == 1 and m["button"] == "left" for m in moves)
    assert (moves[-1]["x"], moves[-1]["y"]) == (100, 50)  # lands exactly on target
    assert (moves[0]["x"], moves[0]["y"]) == (25, 12.5)
    assert evs[-1]["params"]["buttons"] == 0 and evs[-1]["delayMs"] == 250
    assert len(bv.drag_events(0, 0, 1, 1, steps=1)) == 5  # at least 2 moves


def test_wheel_one_event_per_notch():
    evs = bv.wheel_events(5, 5, "up", 3)
    wheels = [e["params"] for e in evs if e["params"]["type"] == "mouseWheel"]
    assert [w["deltaY"] for w in wheels] == [-100, -100, -100]
    assert bv.wheel_events(5, 5, "right", 1)[-1]["params"]["deltaX"] == 100
    with pytest.raises(ValueError):
        bv.wheel_events(5, 5, "sideways", 1)


def test_press_release_track_held_mask_and_moves_report_it():
    evs, held = bv.press_events(3, 4, "left", 0)
    assert held == 1 and evs[-1]["params"]["buttons"] == 1
    mv = bv.move_events(9, 9, held, from_xy=(3, 4), steps=3)
    assert all(m["params"]["buttons"] == 1 and m["params"]["button"] == "left" for m in mv)
    rel, held2 = bv.release_events(9, 9, "left", held)
    assert held2 == 0 and rel[0]["params"]["buttons"] == 0


def test_release_all_frees_buttons_and_modifiers():
    evs = bv.release_all_events(1, 2, 1 | 2)
    kinds = [(e["params"]["type"], e["params"].get("button") or e["params"].get("key")) for e in evs]
    assert kinds == [("mouseReleased", "left"), ("mouseReleased", "right"),
                     ("keyUp", "Shift"), ("keyUp", "Control"), ("keyUp", "Alt"), ("keyUp", "Meta")]


def test_sequence_timeout_grows_with_delays():
    evs = bv.text_events("x" * 200, delay_ms=50)
    assert bv.sequence_timeout(evs) >= 30 + 199 * 0.05


# ---------------------------------------------------------------- state / modes

def test_store_latest_by_tab_and_explicit_id_isolation():
    st = bv.InspectionStore(cap=3)
    a = st.add(_insp(inspect_id="a", tab_id=1))
    b = st.add(_insp(inspect_id="b", tab_id=2))
    a2 = st.add(_insp(inspect_id="a2", tab_id=1, scale_x=2, scale_y=2))
    assert st.get(None, 1) is a2 and st.get(None, 2) is b
    assert st.get("a") is a                       # an agent pinned to its own image
    assert st.get(None, None) is a2               # newest tab overall
    assert st.default_tab(None) == 1 and st.default_tab(5) == 5
    with pytest.raises(ValueError, match="belongs to tab"):
        st.get("a", 2)
    st.add(_insp(inspect_id="c", tab_id=3))       # evicts "a" (cap 3)
    with pytest.raises(ValueError, match="unknown or expired"):
        st.get("a")
    st.forget_tab(1)
    assert st.get(None, 1) is None


def test_inspection_from_capture_builds_mapping_and_surfaces():
    st = bv.InspectionStore()
    res = {"tabId": 4, "imageWidth": 1280, "imageHeight": 757,
           "mapping": {"originX": 0, "originY": 0, "scaleX": 1.5, "scaleY": 1.5},
           "viewport": {"width": 853.3, "height": 504.7},
           "frames": [{"frameId": 0, "href": "u", "innerW": 853, "innerH": 505, "surfaces": [
               {"tag": "canvas", "kind": "novnc", "box": {"x": 40, "y": 30, "w": 800, "h": 600},
                "intrinsic": {"w": 1024, "h": 768}, "fit": "fill"}]}]}
    insp = bv.inspection_from_capture(res, 4, {"maxWidth": 1280}, st)
    assert insp.tab_id == 4 and st.get(None, 4) is insp
    d = bv.describe_surfaces(insp)
    assert d[0]["rect_image"] == {"x": 60, "y": 45, "w": 1200, "h": 712}  # clipped to viewport
    assert d[0]["kind"] == "novnc" and d[0]["framebuffer"] == {"w": 1024, "h": 768}
    with pytest.raises(RuntimeError, match="bad image scale"):
        bv.inspection_from_capture(dict(res, mapping={"scaleX": 0, "scaleY": 1}), 4, {}, st)


def test_pick_type_mode():
    plain = [{"frameId": 0, "hasFocus": True, "active": {"tag": "INPUT", "plainText": True}}]
    canvas = [{"frameId": 0, "hasFocus": True, "active": {"tag": "CANVAS", "plainText": False}}]
    oopif = [{"frameId": 0, "hasFocus": True, "active": {"tag": "IFRAME"}},
             {"frameId": 3, "hasFocus": True, "active": {"tag": "TEXTAREA", "plainText": False}}]
    assert bv.pick_type_mode("auto", plain) == "insert"
    assert bv.pick_type_mode("auto", canvas) == "keys"
    assert bv.pick_type_mode("auto", oopif) == "keys"     # e.g. xterm helper textarea
    assert bv.pick_type_mode("auto", []) == "keys"
    assert bv.pick_type_mode("insert", []) == "insert"
    assert bv.pick_type_mode("KEYS", plain) == "keys"
    with pytest.raises(ValueError):
        bv.pick_type_mode("telepathy", [])
