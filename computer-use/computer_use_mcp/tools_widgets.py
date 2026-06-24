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

from computer_use_mcp import widgets_bus


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    def render_widget(spec: dict, title: str = "", id: str = "") -> str:
        r"""Pop up a CUSTOM widget in the Jarvis desktop app's CANVAS page.

        Use this whenever the user asks you to SHOW, DRAW, or DISPLAY something
        visual ("show me a duck", "draw a bar chart", "make a card that says…").
        You design the UI yourself with a small, safe JSON DSL — no code, just a
        tree of nodes. The widget appears instantly on the desktop CANVAS tab.

        `spec` is a tree of nodes; every node has a "type". Supported types:

          column / row : {type, gap?, children:[...]}      stack children vertically/horizontally
          text         : {type, text, size?, color?, bold?, italic?}   size is px, color is #hex
          rect         : {type, w, h, color?, radius?}      a filled rounded rectangle
          badge        : {type, text, color?}               a small pill label
          image        : {type, url, w?, h?}                 url is http(s):// or a data: URI
          canvas       : {type, w, h, ops:[...]}            free-form drawing; ops are primitives:
              {op:"circle",  x, y, r, fill?}
              {op:"ellipse", x, y, rx, ry, fill?}
              {op:"rect",    x, y, w, h, fill?, radius?}
              {op:"path",    points:[[x,y],...], fill?, stroke?, close?}
              {op:"line",    x1, y1, x2, y2, stroke?, width?}

        Richer interactive / data nodes (all interpreted declaratively, never
        eval'd — actions are DATA mapped to a fixed allow-set):

          button   : {type, text, color?, action:{...}}    a tappable button. `action` is ONE of:
                        {"send":"<chat text>"}              sends that text back into the active chat
                        {"skill":"<name>", "args"?:"<...>"} invokes a skill by name
                      Any other action key does nothing. Use this to give the user a
                      one-tap follow-up ("Refresh", "Run it again", …).
          progress : {type, value, w?, color?, track?}     a determinate bar. `value` is 0..1 OR 0..100.
          list     : {type, rows:[{text, sub?, badge?, color?}...], gap?}   a list of labelled rows.
          grid     : {type, cols, gap?, children:[...]}     an N-column grid of child nodes.
          divider  : {type, color?, vertical?}              a hairline rule (horizontal by default).
          link     : {type, text, url, color?}              opens `url` externally (http/https ONLY).

        Colors are #hex strings; omitted colors fall back to the app theme.
        `title` is an optional card heading.

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
        rec = widgets_bus.append_widget(spec, title=title, widget_id=wid)
        return json.dumps({"ok": True, "rendered": True, "id": rec.get("id", "")})
