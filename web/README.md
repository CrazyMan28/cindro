# JARVIS web console

A browser management dashboard for Jarvis — chat, sessions, memory, skills, and
agents — in the same dark arc-reactor HUD as the desktop app. **No build step, no
framework, no npm:** three static files plus a tiny stdlib-only Python server.

```
web/
  index.html   layout + view mounts
  style.css    the HUD theme (matches desktop Theme.qml palette)
  app.js       Contract A client: WS/RPC layer, chat, sessions, memory, skills, agents
  serve.py     stdlib static server (python3, no deps)
```

## Run it

```bash
python3 web/serve.py            # serves on http://127.0.0.1:8799
python3 web/serve.py --port 8788   # 8799 is used by the Agent Phone server on some machines
python3 web/serve.py --host 0.0.0.0  # expose on the LAN (see "Remote use" below)
```

Then open the printed URL and finish setup:

1. **Setup tab → Pair with a code.** In the Jarvis app open
   *Settings → Browser Extension → “Generate pairing code”*, paste the 6-digit
   code, and click **Pair**. Jarvis fills in the control token for you.
2. Or paste the control token from `~/.config/jarvis/control_token` manually.

Tokens are kept in `localStorage`. Once paired, the **Chat** tab is ready.

## How it connects

The page talks **directly** to the daemon control WebSocket:

```
ws://127.0.0.1:8795/control/ws?token=<control_token>
```

using Contract A v1 framing — `{v:1,id,method,params}` requests, `{v:1,id,ok,result}`
replies, and unsolicited `{event:"session.event",data:{session_id,ev}}` pushes.
`serve.py` only serves the static files; it never proxies or relays the WS.

Pairing uses the one-shot pairing WS (`/control/pair?code=<digits>`) — the daemon
sends one JSON reply `{ok,bearer,bearer_port,control_token,control_port}` then closes.

## Remote use

The daemon's control server is **loopback-only by design**, so the browser must
run on the same machine as `jarvisd`. To use the dashboard from another device,
forward the port instead of exposing the daemon:

```bash
ssh -L 8795:127.0.0.1:8795 your-host       # then browse to the tunnel
# or a Tailscale serve/funnel tunnel to 127.0.0.1:8795
```

There is intentionally **no relay** — keep the control WS on loopback.

## Features

- **Chat** — session list (subagent children filtered out), create
  (`profile:"coworker"`), open, delete; streamed rendering of `thinking`
  (collapsed), `message` bubbles, `tool_call`/`tool_result` cards, `error` cards,
  `approval` cards (Allow / Always / Deny), history replay, and a Stop button.
  Events are strictly scoped to the open session (server `session.subscribe`
  **and** a client-side `session_id` guard). Enter sends, Shift+Enter for newline.
- **Memory** — list / search / remove.
- **Skills** — list / invoke / remove.
- **Agents** — defined agents, a live "running" list, and a simple dispatch form.
- **Status header** — connection state, daemon version, active-agent count, with
  auto-reconnect (exponential backoff) and rejected-RPC cleanup on disconnect.

All dynamic model/user text is rendered via `textContent` (never `innerHTML`) —
this surface displays untrusted model output.
