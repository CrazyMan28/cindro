# JARVIS web console

A full browser dashboard for Jarvis — every page the desktop GUI has, in the
same dark Arc Reactor HUD theme — talking to the same `jarvisd` daemon over
the same loopback control WebSocket the desktop app and TUI use. A Bun+Vite+
SolidJS SPA (no server-rendered pages, no framework lock-in beyond Solid).

```
web/
  index.html        Vite entry (mount point only)
  server.ts          Bun static server for the built dist/ — prints the
                     control token on start, never proxies the control WS
  vite.config.ts, package.json, tsconfig.json
  src/
    main.tsx          bootstrap
    App.tsx            page registry discovery (import.meta.glob) + shell
    core/
      config.ts        token/port resolution (localStorage-backed — a
                       browser tab has no filesystem access)
      control-client.ts   Contract A WebSocket client (multi-subscriber
                          event bus, per-session queues)
      router.ts          page registry (PageDef) — pages self-register,
                         this file is never edited when a page is added
      theme.css, theme.ts   design tokens ported 1:1 from desktop/qml/Theme.qml
    components/
      NavRail.tsx, NavIcon.tsx, HudStatusStrip.tsx, ArcReactor.tsx,
      CommandPalette.tsx, SetupWizard.tsx, WidgetRenderer.tsx
    pages/            one file (or folder, for Phone/Settings) per page
```

## Run it

```bash
cindro web start      # builds + serves on http://127.0.0.1:8788, prints the control token
cindro web stop
```

or directly:

```bash
cd web && bun install && bun run build && bun server.ts --port 8788
```

For local development with live-reload instead of a static build:

```bash
cd web && bun run dev     # vite dev server on :8788
```

Then open the URL and finish setup:

1. **Pair with a code.** In the Cindro desktop app open
   *Settings → Browser Extension → "Generate pairing code"*, paste the
   6-digit code into the web dashboard's Setup screen, and click **Pair with
   code**. Cindro fills in the control token for you.
2. Or paste the control token yourself — `cindro web start` prints it to the
   terminal, or read it from `~/.config/jarvis/control_token`.

Tokens are kept in `localStorage`, scoped to this origin.

## How it connects

The page talks **directly** to the daemon control WebSocket:

```
ws://127.0.0.1:8795/control/ws?token=<control_token>
```

using Contract A v1 framing — `{v:1,id,method,params}` requests, `{v:1,id,ok,result}`
replies, and unsolicited `{event:"...",data:{...}}` pushes. `server.ts` only
serves the built static files; it never proxies or relays the control WS.

## Remote use

The daemon's control server is **loopback-only by design**, so the browser
must run on the same machine as `jarvisd`. To use the dashboard from another
device, forward the port instead of exposing the daemon:

```bash
ssh -L 8795:127.0.0.1:8795 your-host       # then browse to the tunnel
# or a Tailscale serve/funnel tunnel to 127.0.0.1:8795
```

There is intentionally **no relay** — keep the control WS on loopback.

## Pages

Matches the desktop GUI's page set (WORKSPACE / MIND / SYSTEM), plus one
deliberate addition:

- **WORKSPACE** — Home, Chat, Voice, Computer, Canvas, Widgets, Sessions,
  and **Browser** (an addition beyond the GUI's page set — see "Known
  differences from the desktop GUI" below).
- **MIND** — Memory, Skills, Agents, Schedules, Activity, Graph, Replay.
- **SYSTEM** — MCP, Plugins, SSH, Phone (6 tabs: Calls, Agents, Inbox, HUD,
  Settings, Screening), Settings (12 sections: Identity, Defaults, Mode &
  Autonomy, Voice, Video, API Keys, Security, Trust Policies, Updates,
  Connectors, Extension, Devices).

## Known differences from the desktop GUI

These are deliberate, documented trade-offs of running in a browser tab
rather than a native Qt app with local filesystem/host access — not bugs:

- **Widgets library (pinned/saved widgets)** — the desktop GUI and TUI both
  read/write `~/.local/share/jarvis/saved_widgets.json` directly; a browser
  tab can't touch that file, and there's no daemon RPC for it either. The
  web dashboard's saved-widget library uses `localStorage` instead
  (`jarvis.web.savedWidgets`) — it is **not synced** with the GUI/TUI's
  shared library. The live Canvas feed (ephemeral, daemon-broadcast) has
  full parity.
- **CPU / RAM / NET gauges** — the desktop GUI's status strip reads these
  from `/proc` directly (native Bridge.cpp code); there's no Contract A verb
  exposing host telemetry, so the web status strip omits them rather than
  fabricate numbers. It shows real MCP-server count, active-agent count, and
  connection status instead.
- **`ssh.exec`** — the daemon's SSH allow-list CRUD (`ssh.allow_list/
  allow_add/allow_remove`) works for real. `ssh.exec` (running a gated
  command) is a server-side stub that always replies "not available yet" —
  the web SSH page surfaces that real response rather than faking a
  terminal.
- **Browser page** — `desktop/qml/BrowserPage.qml` exists but was never
  wired into the GUI's `AppShell.qml` (orphaned code); the web version is
  ported from the TUI's shipped `Browser.tsx` instead, since that's the only
  actually-live reference implementation for this page.
- **`queue`** is a reserved page id with real daemon verbs
  (`queue.add/list/...`) but is unrouted in both the GUI and TUI navigation —
  left unrouted here too rather than building a from-scratch UI for it.

## Security

- The Computer page's live desktop mirror, the SSH allow-list, and the Phone/
  Twilio surface all sit behind the same loopback control-token trust
  boundary the rest of the dashboard already has — no new "who can do this"
  risk beyond "whoever holds the token."
- All dynamic model/user text renders through Solid's `{}` text
  interpolation (never `innerHTML`) — this surface displays untrusted model
  output. The one exception is `WidgetRenderer.tsx`'s `svg` node, which
  renders via `<img src="data:image/svg+xml;base64,...">` rather than
  `innerHTML` specifically so embedded `<script>`/`on*` markup can't execute.
