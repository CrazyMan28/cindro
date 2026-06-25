"""Generative-widget MCP tool — render custom UI in the Jarvis desktop app.

Exposed on the computer-use engine alongside the other Jarvis tools. The model
calls `render_widget(spec)` with a small JSON widget spec; the engine appends it
to the widgets bus (~/.local/share/jarvis/widgets.jsonl) and the desktop app's
CANVAS page renders it declaratively. The spec is a safe JSON DSL — it is NEVER
evaluated as code.
"""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import live_widgets, saved_widgets, widgets_bus


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    def render_widget(spec: dict, title: str = "", id: str = "",
                      target: str = "canvas") -> str:
        r"""Render a CUSTOM widget on the Jarvis Canvas (and optionally in chat).

        Use this whenever the user asks you to SHOW, DRAW, or DISPLAY something
        visual ("show me a duck", "draw a bar chart", "make a card that says…").
        You design the UI yourself — its SIZE and LOOK are up to you — with a small,
        safe JSON DSL (no code, just a tree of nodes).

        `target` controls WHERE it surfaces:
          "canvas" (default) — lives on the Canvas tab only (quiet; doesn't
                               interrupt the conversation).
          "chat"             — ALSO drops inline into the live chat, like a tool
                               result. Use this when the user asks to see it right
                               here ("show me … in chat", "draw me … now").
          "voice"            — pops near the voice orb (use in voice mode).
          "both"             — chat + canvas.
        Only put a widget in chat/voice when the user actually wants it there.

        `spec` is a tree of nodes; every node has a "type". Supported types:

        CONTAINERS (build any layout; style + size them yourself):
          column / row : {type, children:[...]}            stack children vertically / horizontally
          grid         : {type, cols, children:[...]}       an N-column grid
            Container options: gap (child spacing), pad (inner padding), bg (#hex
            background), radius, border (#hex) + borderW, and SIZE via w / h or
            fill:true (take the full available width). Use these to make real cards
            and panels of ANY size.
          PER-CHILD layout: any child may set grow:true (expand to fill the line),
            align:"left"|"center"|"right", and w / h to size itself.

        LEAVES:
          text     : {type, text, size?, color?, bold?, weight?(100-900), italic?,
                      spacing?, line?(lineHeight x), align?, mono?, display?, maxLines?}
          badge    : {type, text, color?}                   a small pill label
          rect     : {type, w, h, color?, radius?}          a filled rounded rectangle
          spacer   : {type, size?}  or {type, grow:true}    fixed gap, or flexible pusher
          divider  : {type, color?, vertical?}              a hairline rule
          progress : {type, value, w?, color?, track?}      determinate bar; value 0..1 OR 0..100
          list     : {type, rows:[{text, sub?, badge?, color?}...], gap?}   labelled rows
          link     : {type, text, url, color?}              opens url externally (http/https ONLY)
          image    : {type, url, w?, h?}                     url is http(s):// or a data: URI
          button   : {type, text, color?, textColor?, radius?, size?, action:{...}}
                       a tappable button. `action` is ONE of:
                        {"send":"<chat text>"}              sends that text back into THIS chat
                        {"skill":"<name>", "args"?:"<...>"} invokes a skill by name
                       Any other action key does nothing. Great for one-tap follow-ups.

        ART / CHARTS (the "real renderer" — draw actual graphics, not a label):
          svg      : {type, svg:"<svg …>…</svg>", w?, h?}   raw SVG markup, rendered for real
          canvas   : {type, w, h, ops:[...]}                free-form draw ops:
              {op:"circle",  x, y, r, fill?}
              {op:"ellipse", x, y, rx, ry, fill?}
              {op:"rect",    x, y, w, h, fill?, radius?}
              {op:"path",    points:[[x,y],...], fill?, stroke?, close?}
              {op:"line",    x1, y1, x2, y2, stroke?, width?}

        Colors are #hex strings; omitted colors fall back to the app theme. Give the
        top node a sensible w/h or fill:true so it isn't cramped. `title` is an
        optional card heading.

        ANIMATION: any node may carry "anim" to make it move/breathe:
          {"anim":{"type":"pulse"|"fade"|"spin"|"float"|"blink",
                   "duration":<ms, default 1200>, "loop":true}}
          pulse = scale in/out, fade = opacity in/out, spin = rotate 360,
          float = bob up/down, blink = hard on/off. Great for live dashboards,
          loaders, "breathing" status dots, a spinning reactor, etc.

        `id` lets you ADDRESS a widget so you can UPDATE it later: call
        render_widget again with the SAME `id` (and a new `spec`) and the desktop
        replaces that card in place instead of stacking a duplicate — e.g. to
        "update the progress bar to 80%", re-render the progress node with the
        same id. The return value tells you the id that was used. You may also set
        a top-level `id` on the spec itself; the `id` param wins.

        Example — for "show me a duck", emit:
          {"type":"column","gap":6,"children":[
            {"type":"text","text":"Here's your duck \U0001f986","size":16,"color":"#7FF4FF"},
            {"type":"canvas","w":160,"h":140,"ops":[
              {"op":"ellipse","x":80,"y":95,"rx":48,"ry":34,"fill":"#FFD23F"},
              {"op":"circle","x":120,"y":55,"r":24,"fill":"#FFD23F"},
              {"op":"path","points":[[140,52],[164,58],[140,66]],"fill":"#FF8C2B","close":true},
              {"op":"circle","x":126,"y":50,"r":4,"fill":"#0A0E16"}]}]}

        Returns {"ok": true, "rendered": true, "id": "<resolved id>"} — reuse that
        id to update the same widget later.
        """
        # The `id` param wins; otherwise honor a top-level spec id; else fallback.
        spec_id = ""
        if isinstance(spec, dict):
            spec_id = str(spec.get("id") or "")
        wid = str(id or "").strip() or spec_id.strip()
        rec = widgets_bus.append_widget(spec, title=title, widget_id=wid, target=target)
        return json.dumps({"ok": True, "rendered": True,
                           "id": rec.get("id", ""), "target": rec.get("target", "canvas")})

    # ----- Canvas management (the ad-hoc, drawn-once items) -----------------
    @mcp.tool()
    def canvas_list() -> str:
        """List the canvases currently on the Jarvis Canvas tab (id, title, spec,
        target), newest first. Use before editing or deleting one so you know what
        is there."""
        return json.dumps({"ok": True, "canvases": widgets_bus.list_canvases()})

    @mcp.tool()
    def canvas_edit(id: str, spec: dict, title: str = "", target: str = "canvas") -> str:
        """Replace a canvas's spec in place (same id). Equivalent to render_widget
        with that id, kept as an explicit verb for clarity."""
        rec = widgets_bus.append_widget(spec, title=title, widget_id=str(id), target=target)
        return json.dumps({"ok": True, "id": rec.get("id", "")})

    @mcp.tool()
    def canvas_del(id: str) -> str:
        """Delete a canvas by id (removes its card from the Canvas tab)."""
        widgets_bus.append_op("remove", str(id))
        return json.dumps({"ok": True, "removed": str(id)})

    @mcp.tool()
    def canvas_clear() -> str:
        """Remove ALL canvases (clears the Canvas tab)."""
        widgets_bus.append_op("clear")
        return json.dumps({"ok": True, "cleared": True})

    # ----- Saved widget library (reusable, named specs) --------------------
    @mcp.tool()
    def widget_save(name: str, spec: dict, id: str = "") -> str:
        """Save a REUSABLE widget to the library under `name` so you (or the user)
        can render it again later without rebuilding the spec. Pass an existing id
        (or reuse a name) to update it. Returns the saved id."""
        rec = saved_widgets.save_widget(name, spec, widget_id=str(id))
        return json.dumps({"ok": True, "id": rec.get("id", ""), "name": rec.get("name", "")})

    @mcp.tool()
    def widget_list() -> str:
        """List saved (reusable) widgets in the library: id, name, updated. Use this
        to find a widget to re-render with widget_render instead of rebuilding it."""
        items = [{"id": w.get("id"), "name": w.get("name"), "updated": w.get("updated", 0)}
                 for w in saved_widgets.list_widgets()]
        return json.dumps({"ok": True, "widgets": items})

    @mcp.tool()
    def widget_get(id: str) -> str:
        """Get a saved widget's full record (incl. its spec) by id or name."""
        w = saved_widgets.get_widget(str(id))
        if not w:
            return json.dumps({"ok": False, "error": "not_found"})
        return json.dumps({"ok": True, "widget": w})

    @mcp.tool()
    def widget_edit(id: str, spec: dict, name: str = "") -> str:
        """Update a saved widget's spec (and optionally rename it)."""
        existing = saved_widgets.get_widget(str(id))
        if not existing:
            return json.dumps({"ok": False, "error": "not_found"})
        rec = saved_widgets.save_widget(name or existing.get("name", ""), spec,
                                        widget_id=existing.get("id", str(id)))
        return json.dumps({"ok": True, "id": rec.get("id", "")})

    @mcp.tool()
    def widget_del(id: str) -> str:
        """Delete a saved widget from the library by id or name."""
        ok = saved_widgets.remove_widget(str(id))
        return json.dumps({"ok": ok, "removed": str(id) if ok else ""})

    @mcp.tool()
    def widget_render(id: str, target: str = "canvas", title: str = "") -> str:
        """Render a SAVED widget (by id or name) onto the Canvas (or chat/voice via
        `target`) without rebuilding its spec. The reuse path for the library."""
        w = saved_widgets.get_widget(str(id))
        if not w:
            return json.dumps({"ok": False, "error": "not_found"})
        rec = widgets_bus.append_widget(w.get("spec"), title=title or w.get("name", ""),
                                        widget_id="", target=target)
        return json.dumps({"ok": True, "id": rec.get("id", ""), "from": w.get("id")})

    # ----- Live (auto-updating) widgets ------------------------------------
    @mcp.tool()
    def widget_live(id: str, command: str, spec: dict, interval_sec: float = 5,
                    title: str = "", target: str = "canvas") -> str:
        r"""Make a widget UPDATE LIVE, on its own, in the background — for ANYTHING,
        not just system stats. A detached loop runs `command` every `interval_sec`
        seconds, takes its stdout, substitutes it into `spec` wherever the literal
        token "{{value}}" appears, and re-renders the widget under `id` (so the card
        updates in place). The model chooses the command, the cadence, and the look.

        Examples:
          - live CPU%:   command="top -bn1 | awk '/Cpu/{print 100-$8}'"
            spec={"type":"column","gap":4,"children":[
                    {"type":"text","text":"CPU {{value}}%","weight":700},
                    {"type":"progress","value":"{{value}}","grow":true}]}
          - any value:   command="curl -s https://api.example.com/price"
            spec={"type":"text","text":"Price: {{value}}","size":18}

        Pick interval_sec for how often it refreshes (min 1s). Call widget_live_stop(id)
        to stop it, or widget_live_list() to see what's running. For a one-shot
        (no updating) widget, use render_widget instead.
        """
        job = live_widgets.start(str(id), str(command), interval_sec, spec,
                                 title=title, target=target)
        return json.dumps({"ok": True, "id": job.get("id", ""), "pid": job.get("pid", 0),
                           "interval_sec": job.get("interval_sec")})

    @mcp.tool()
    def widget_live_stop(id: str) -> str:
        """Stop a live (auto-updating) widget's background refresher."""
        return json.dumps({"ok": True, "stopped": live_widgets.stop(str(id))})

    @mcp.tool()
    def widget_live_list() -> str:
        """List live (auto-updating) widget jobs and whether each is still running."""
        return json.dumps({"ok": True, "jobs": live_widgets.list_jobs()})
