# Canvas & Widgets — the generative UI system

Jarvis can render real, interactive UI from a small **safe JSON DSL** (never code).
Two concepts:

- **Canvas** — an *ad-hoc* thing the model draws once (a duck, a chart, a status
  card). Lives on the **Canvas** tab; can also drop inline into chat/voice.
- **Widget** — a **saved, reusable** canvas the user kept in the **Widgets** tab.
  Tap **★** on any canvas (in chat or on the Canvas tab) to save it; the model can
  list/render saved widgets to reuse them without rebuilding the spec.

Everything is rendered by the safe `WidgetRenderer` (desktop QML) — the spec is
DATA, interpreted node-by-node, never `eval`'d.

## The bus

`render_widget` (and friends) append one JSON line per record to
`~/.local/share/jarvis/widgets.jsonl`:

```
{"ts":<ms>,"title":"…","id":"…","spec":{…},"target":"canvas","session_id":"…"}
{"op":"remove","id":"…"}        # delete one canvas
{"op":"clear"}                  # delete all
```

The desktop tails the file (offset-based). Re-appending with the **same id**
updates that card in place. `target` gates where it surfaces; `session_id` scopes
it to its chat and lets a reopened session replay its widgets. Saved widgets live
separately in `~/.local/share/jarvis/saved_widgets.json`.

## DSL nodes

Every node has a `type`. Containers nest via `children`.

**Containers** (stylable + sizable):
`column` / `row` / `grid` — `gap`, `pad`, `bg`, `radius`, `border`(+`borderW`),
`w`/`h` or fill their slot by default; `grid` adds `cols`.
Per-child layout hints: `grow:true` (fill the line), `align:"left|center|right"`,
`w`/`h`.

**Leaves:**
`text` (`color,size,bold,weight 100-900,italic,spacing,line,align,mono,display,maxLines`),
`badge`, `rect` (`w,h,radius,color`), `divider`, `spacer` (`size` or `grow`),
`progress` (`value` 0..1 or 0..100), `list` (`rows:[{text,sub,badge,color}]`),
`link` (http/https), `image` (`url,w,h`),
`button` (`text,color,textColor,radius,size,action:{send|skill}`) — actions route
back into chat.

**Art / charts:**
`svg` (`svg:"<svg…>",w,h`) — real vector art; `canvas` (`w,h,ops:[…]`) with
`circle/ellipse/rect/path/line` draw ops.

**Animation:** any node may carry
`anim:{type:"pulse|fade|spin|float|blink", duration:<ms>, loop:true}` — a
render-only transform, so it never disturbs layout.

> Implementation note: nested arrays reach a child node as a QVariantList (not a JS
> Array), so the renderer coerces array-likes with `asArray()` at every array site —
> that's what makes nested grids/lists render at any depth (the old "only the title
> shows" / "empty cells" bugs).

## Live (auto-updating) canvases

`widget_live(id, command, spec, interval_sec, target)` makes a canvas refresh on
its own — for **anything**, not just system stats. A detached loop runs `command`
every `interval_sec`, substitutes its stdout wherever the literal token
`{{value}}` appears in `spec`, and re-renders that id. `widget_live_stop(id)` /
`widget_live_list()` manage jobs. Example (live CPU):

```
command = "top -bn1 | awk '/Cpu/{print 100-$8}'"
spec    = {"type":"column","gap":4,"children":[
            {"type":"text","text":"CPU {{value}}%","weight":700},
            {"type":"progress","value":"{{value}}","grow":true}]}
```

Jobs are tracked in `~/.local/share/jarvis/widget_jobs/<id>.json` and survive the
(per-session) engine process.

### Lifecycle / battery — viewer-gated live jobs

Live jobs used to run **forever** (deleting a canvas only removed the render, never
the loop), draining battery on the laptop *and* every paired phone. Now:

- **One supervisor, not N loops.** A single detached supervisor process
  (`live_widgets.py`, pid-file `~/.local/share/jarvis/widget_supervisor.pid`, started
  by the host engine `lifespan` + `start()`) runs **all** jobs in-process. `pause`
  = skip a tick (no shell exec, no append); a deleted job file = drop it.
- **A job only does work while a VIEWER is watching it.** The daemon owns a lease
  registry at `~/.local/share/jarvis/widget_viewers/*.json` (`{scope, kind, ts}`,
  45 s TTL, wiped on daemon startup). Desktop + phone send `widget.viewing`
  /`widget.pin`; the supervisor reads the leases. Scopes: a chat `session_id`
  (kind `chat`), `"all"` (the Canvas/Widgets tab, kind `canvas`), `"widget:<id>"`
  (a popped-out window `popout`, or a phone home-screen `pin`).
- Unwatched → the job idles (battery). A viewer returning **force-renders** once so
  it's current. `canvas_del`/`widget_del`/`canvas_clear`/`widget_live_stop` all stop
  the job (the supervisor also honors the desktop "✕" bus marker).
- **Pinned home-screen widgets** keep a job alive but at a **≥60 s** cadence floor,
  value-deduped, and the phone only heartbeats the pin **while unlocked** (aggressive
  battery). The daemon relays a pinned widget's renders to that phone even with no
  chat open, throttled per-(device,widget) to 60 s.

### Real Android home-screen widget

Tap **📌 Pin** on a canvas (in chat or the phone Canvas tab) → it becomes a real
Android AppWidget (`JarvisWidgetProvider`). The DSL is drawn to a bitmap by a
headless `WidgetBitmapRenderer` (RemoteViews can't host Compose / a WebView can't be
snapshotted), so text/progress/list/badge/rect and `canvas` draw-op charts render on
the home screen; `svg`/`image` degrade to "open app". Updates are **push-driven**
over the device WS (the foreground service redraws on each live render —
`updatePeriodMillis=0`, no polling). Add it via the 1-click pin (`requestPinAppWidget`)
or the OS widget picker (`WidgetConfigActivity`).

## MCP tools (computer-use engine)

| Tool | Purpose |
|---|---|
| `render_widget(spec,title,id,target)` | draw a canvas (`target`: canvas/chat/voice/both) |
| `canvas_list / canvas_edit / canvas_del / canvas_clear` | manage canvases |
| `widget_save / widget_list / widget_get / widget_edit / widget_del` | the saved library |
| `widget_render(id,target)` | re-show a saved widget |
| `widget_live / widget_live_stop / widget_live_list` | live auto-updating canvases |

## Desktop surfaces

- **Canvas tab** — all current canvases; each card has ★ save, ⧉ pop-out, ✕ delete.
- **Widgets tab** — the saved library; each previews live with → Canvas / → Chat / delete.
- **Chat** — a canvas appears inline only when `target` is `chat`/`both`; hover a
  card for the ★ save button. Scoped to the session and replayed on reopen.
- **Voice** — floats near the orb when `target` is `voice`.
