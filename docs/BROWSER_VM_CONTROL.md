# Graphical VMs and remote desktops inside Chrome

Cindro's browser tools were built for ordinary web pages: `browser_snapshot` lists DOM elements
and `browser_click`/`browser_type` act on them by ref. That breaks down when a tab shows a
**graphical machine**: a Windows or Linux VM console (Proxmox/noVNC, Apache Guacamole, SPICE,
VMware Web Console, Kasm, IPMI/iDRAC/PiKVM KVMs), a WebRTC remote desktop, or any canvas app. The
guest desktop is pixels on a `<canvas>` (or a `<video>`), often in nested, cross-origin iframes.
There are no elements to snapshot, and synthetic JS events or DOM value changes never reach the
guest.

The graphical tools close that gap with the existing pieces: the engine (`computer-use/`), the
Chrome extension bridge (`/ws/extension`), and Chrome DevTools Protocol input. Nothing is
installed in the guest, and no extra vision API is used: the model reads the screenshots with
its own vision.

## The loop

1. **Look.** `browser_visual_inspect` captures the tab. It returns the image plus metadata: an
   `inspect_id`, the graphical **surfaces** found in every frame (kind, rect in image pixels, the
   guest framebuffer size, whether it has focus), and `graphical: true` with a hint when DOM tools
   won't work. `browser_snapshot` adds the same `graphical` flag, so the agent can switch modes
   automatically.
2. **Find the target.** The model reads the image and picks a point (the Start button, a
   PowerShell window, a text field). It measures pixels on that image and never needs coordinates
   from the user.
3. **Act** with real input: `browser_click_xy`, `browser_move_xy`, `browser_drag_xy`,
   `browser_scroll_xy`, `browser_mouse_down`/`browser_mouse_up`, `browser_key_press`,
   `browser_type_trusted`.
4. **Verify.** Pass `verify=True` to any action. It waits `settle_ms`, re-captures the same view
   and reports `screen_changed`/`change_ratio`, and returns the new image. Coordinates then refer
   to that new image.
5. **Retry or replan** if the change didn't happen.

To read small console text (command output in a VM terminal), zoom in with
`browser_visual_inspect(surface="s1")` or `region_x/y/w/h`. That returns a magnified crop, and
clicks measured on the crop still land correctly.

Example: *"Look at the Windows VM open in Chrome, open PowerShell, check the network
configuration."* → `browser_visual_inspect` (finds a `novnc` surface) → `browser_click_xy` on the
console to focus it → `browser_key_press("win+r")` → `browser_type_trusted("powershell",
submit=True)` → `browser_type_trusted("ipconfig /all", submit=True, verify=True)` →
`browser_visual_inspect(surface="s1")` to read the output → continue troubleshooting.

## Coordinates

Every point tool takes `coord_space`:

| space | meaning |
|---|---|
| `image` (default) | pixels on the latest `browser_visual_inspect` image of the tab (or the one named by `inspect_id`) |
| `viewport` | main-frame CSS pixels (CDP `Input.*` space) |
| `surface` | guest framebuffer pixels of `surface` (default the biggest), e.g. 1920×1080 for a 1080p VM |

The extension **measures** the mapping instead of guessing it. It captures with
`Page.captureScreenshot` (device pixels), reads the main frame's `innerWidth`/`innerHeight`, and
the ratio absorbs device pixel ratio, browser zoom, the debugger infobar, and any crop or
downscale. Surfaces are placed through the iframe chain: offsets, borders, padding and CSS-
transform scale, matched to frames by URL and size because Chrome doesn't tell a content script
which `<iframe>` hosts it. `object-fit` letterboxing is resolved too. A guest pixel maps to its
centre, and the integer CSS point is clamped inside the drawn rect (Chrome hit-tests the right
and bottom edge as outside).

**Stale mappings are refused, not guessed.** Every action carries the viewport size and scroll
position of the inspection it was measured on. If the console was resized, went fullscreen, or
the page scrolled, the extension aborts before dispatching ("viewport changed…" / "page
scrolled…") and the agent re-inspects.

## Input

- Mouse: CDP `Input.dispatchMouseEvent`. A `mouseMoved` always comes first, because VNC/RDP
  clients only learn the pointer position from motion. `clickCount` increments, so double-clicks
  register. Drags set `buttons` on every move. Wheel events are sent one per notch, because
  noVNC/Guacamole send at most one remote wheel click per event. CDP input is routed by Chrome's
  own hit-test, so it reaches cross-origin OOPIF consoles.
- Keyboard: CDP `Input.dispatchKeyEvent` with US-layout `key`/`code`/`keyCode` triples, which is
  what noVNC and Guacamole turn into keysyms and scancodes. Modifiers are real key-down/key-up
  events with the right bitmask: `ctrl+alt+delete`, `win+r`, `alt+tab`, `ctrl+shift+esc` and
  `alt+f4` go to the guest, not to Chrome or the host OS. Command chords carry no `text`, so
  `ctrl+c` never types a "c".
- Text: `browser_type_trusted` defaults to `mode="auto"`. Inside a canvas console, terminal or
  cross-origin frame it types each character as a key press (`keys`, with `delay_ms` for slow
  VMs). It uses `Input.insertText` (`insert`) only when a plain text field is focused. `\n` presses
  Enter.
- Focus: the first graphical input enables `Emulation.setFocusEmulationEnabled`, so the page acts
  focused even while the user is in another window. Consoles otherwise drop keys.
- Held input: `browser_mouse_down`/`up` track the held buttons per tab. If an event batch fails
  midway, the extension releases the held buttons and modifiers. `browser_input_release` frees
  anything stuck.

## Safety and boundaries

- It works only through the user's Chrome extension and its existing bearer-token WebSocket.
  `input.sequence` dispatches an **allowlist** of `Input.*` methods only; it is not a generic CDP
  passthrough. Debugger attach shows Chrome's standard "being debugged" banner.
- `browser_visual_inspect` is read-only and allowed in Plan Mode. Every acting tool is gated like
  other browser actions, by trust policies (`browser_*` globs) and Plan Mode.
- Text typed into a VM goes through the same destructive-command scanner as `bg_start`
  (`policy._scan_command`). Typing `rm -rf /` or `shutdown` into a remote terminal asks the user
  first.
- In the Cindro extension, the glow cursor follows coordinate input. It is hidden during captures
  so it never appears in what the model reads.
- `inspect_id` keeps concurrent agents apart. An agent that passes the id it got back keeps using
  its own image's mapping, even if another agent re-inspected the tab since.

## Files

| file | role |
|---|---|
| `computer-use/computer_use_mcp/browser_visual.py` | pure logic: mapping, frame/letterbox composition, CDP event builders, inspection store |
| `computer-use/computer_use_mcp/tools_browser_visual.py` | the MCP tools + the `browser_snapshot` graphical hint |
| `extension/visual.js` (= `computer-use/extension/visual.js`) | capture/measure/frame scan + validated `input.sequence` dispatch, loaded by `sw.js` |
| `core/src/ApiBrain.cpp` | forwards MCP image results to OpenAI-compatible API models (see below) |

**API models see the screenshots too.** OpenAI-style `tool` messages are text-only, so `ApiBrain`
appends the round's tool images as one follow-up user message. Only the newest two keep their
pixels. A backend that rejects images (a non-vision model) gets them dropped, and the request is
retried once. Claude/Codex CLI brains get MCP images natively.

## Tests

- `computer-use/tests/test_browser_visual.py`: mapping, letterbox, frames, keys, mouse, store.
- `computer-use/tests/test_browser_visual_tools.py`: the tools against a scripted bridge
  (errors, upgrade hint, disconnect, isolation, verify, policy hooks).
- `computer-use/tests/test_browser_vm_chromium.py`: **real headless Chromium** with both shipped
  extensions loaded, driving fake noVNC and Guacamole consoles. It covers a cross-origin OOPIF, a
  nested iframe, a CSS-scaled iframe, a letterboxed canvas, 150% zoom, DPR 2, resize, scroll and
  fullscreen, disconnect and reconnect, and failure release. It skips without a Chromium binary;
  `CINDRO_TEST_CHROMIUM` picks one.
- `core/tests/api_brain_tools_test.cpp`: tool-image forwarding and pruning.

## Limits

- The keyboard map is US layout. Characters outside it are sent as key and text events, which
  noVNC maps to Unicode keysyms. A guest with a different layout may need `mode="insert"` or the
  console's own clipboard.
- A guest framebuffer bigger than its on-screen canvas can't be addressed below one CSS pixel.
- Chrome's own UI (tab strip, permission prompts) and `chrome://` pages aren't scriptable; use
  the desktop computer-use tools for those.
- A frame that can't be matched to its `<iframe>` slot reports `frame_placement: "none"`. Image
  coordinates still work there; `surface` coordinates don't.
