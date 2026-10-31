"""Static checks on the two shipped Chrome extensions' graphical-control wiring
(runs everywhere, no browser needed)."""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
EXTS = [REPO / "extension", REPO / "computer-use" / "extension"]


def test_visual_js_is_identical_in_both_extensions():
    a, b = (e / "visual.js" for e in EXTS)
    assert a.read_bytes() == b.read_bytes(), (
        "extension/visual.js and computer-use/extension/visual.js diverged — copy one over the other")


def test_service_workers_load_visual_js_and_expose_its_handlers():
    for ext in EXTS:
        sw = (ext / "sw.js").read_text()
        # importScripts must run at top level, before HANDLERS is used.
        assert re.search(r'^importScripts\("visual\.js"\);$', sw, re.M), ext
        assert sw.index('importScripts("visual.js")') < sw.index("const HANDLERS")
        assert "Object.assign(HANDLERS, VISUAL_HANDLERS);" in sw
        manifest = json.loads((ext / "manifest.json").read_text())
        assert manifest["background"]["service_worker"] == "sw.js"
        assert manifest["background"].get("type") != "module"   # importScripts needs classic
        assert "debugger" in manifest["permissions"] and "scripting" in manifest["permissions"]


def test_visual_handlers_cover_the_engine_protocol():
    js = (EXTS[0] / "visual.js").read_text()
    for method in ("page.inspect", "page.surfaces", "page.focus", "input.sequence"):
        assert f'"{method}"' in js
    # The input path is an allowlist of Input.* — never a generic CDP passthrough.
    allowed = re.search(r"VISUAL_INPUT_METHODS = new Set\(\[(.*?)\]\)", js, re.S).group(1)
    assert sorted(re.findall(r'"([^"]+)"', allowed)) == [
        "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.insertText"]


def test_extension_versions_bumped_for_the_new_protocol():
    def ver(ext):
        return tuple(int(x) for x in json.loads((ext / "manifest.json").read_text())["version"].split("."))
    assert ver(EXTS[0]) >= (0, 6, 0)
    assert ver(EXTS[1]) >= (0, 3, 0)


def test_cindro_content_script_moves_the_glow_cursor_for_xy_input():
    content = (EXTS[0] / "content.js").read_text()
    assert re.search(r"pointAt: \(p\) =>", content)
