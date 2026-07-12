# cindro-mcp

One **MCP endpoint** that fronts the whole Cindro stack so external agents
(Claude Code / Codex) can drive Cindro **and** do full computer use through a
single server.

- **Port:** `8797` (HTTP streamable MCP at `/mcp`). `8790` project-tracker,
  `8791` phone-installer, `8794` computer-use, `8795` jarvisd control,
  `8796` jarvisd device → `8797` is free.
- **Auth:** bearer token at `~/.config/jarvis/jarvis_mcp_token` (0600,
  auto-generated on first start), or the `JARVIS_MCP_TOKEN` env override.
  Every path is token-gated except `/health` (open readiness probe) — the same
  tailnet bearer model as `computer-use`.

## What it exposes

### Cindro orchestration (`jarvis_*`) — wraps Contract A (jarvisd control WS)

These call the daemon's control WebSocket
(`ws://127.0.0.1:8795/control/ws`, token from `~/.config/jarvis/control_token`):

| tool | Contract-A method |
| --- | --- |
| `jarvis_ping` | `ping` |
| `jarvis_start_session(profile, brain, model, target, cwd, title)` | `session.create` |
| `jarvis_send(session_id, text, images?)` | `session.send` |
| `jarvis_cancel_session(session_id)` | `session.cancel` |
| `jarvis_list_sessions()` | `session.list` |
| `jarvis_session_history(session_id, limit)` | `session.history` |
| `jarvis_session_events(limit)` | drains buffered unsolicited `session.event` frames |
| `jarvis_approval_respond(session_id, approval_id, decision)` | `approval.respond` |
| `jarvis_queue_task(text, when?, name?, brain?, model?, profile?)` | `schedule.create` |
| `jarvis_list_tasks()` | `schedule.list` |
| `jarvis_memory_search(q, limit)` | `memory.search` |
| `jarvis_memory_add(text, tags?)` | `memory.add` |
| `jarvis_skill_list()` | `skills.list` |
| `jarvis_skill_invoke(name, args?)` | `skills.invoke` |
| `jarvis_today()` | `skills.today` |

### Computer use (`jarvis_cu_*`) — re-exported from the engine at `:8794`

At startup the server connects to the computer-use FastMCP engine
(bearer read from `~/.computer-use/config.yaml`), discovers its tools with
`tools/list`, and registers **one passthrough proxy per tool** under the
`jarvis_cu_` prefix. The proxy reports the **upstream input schema verbatim**
and forwards `tools/call` unchanged, so all 32 computer-use tools
(`jarvis_cu_mouse_click`, `jarvis_cu_desktop_screenshot`,
`jarvis_cu_browser_navigate`, …) are reachable through this one endpoint. The
re-export is dynamic, so it never drifts from the engine's tool list. If the
engine is down at startup the server still serves the Cindro-only surface.

## Run

```bash
cd jarvis-mcp
env -u PYTHONPATH uv run cindro-mcp        # serves 0.0.0.0:8797/mcp
curl -s http://127.0.0.1:8797/health | jq  # open readiness probe
```

`/health` reports `daemon_control_ok`, `jarvis_tools`, and
`computer_use_reexported` (the proxy count).

## Register with an agent

```bash
./client-setup.sh            # print the Claude + Codex snippets
./client-setup.sh --apply    # patch ~/.claude.json AND ~/.codex/config.toml
./client-setup.sh --claude   # only ~/.claude.json
./client-setup.sh --codex    # only ~/.codex/config.toml
```

- Claude Code (`~/.claude.json` → `mcpServers.cindro`): `type:"http"`, `url`,
  `headers.Authorization: "Bearer <token>"`.
- Codex (`~/.codex/config.toml` → `[mcp_servers.cindro]`): `url` +
  `bearer_token_env_var = "JARVIS_MCP_TOKEN"`; then
  `export JARVIS_MCP_TOKEN="$(cat ~/.config/jarvis/jarvis_mcp_token)"`.

Patching is idempotent (re-running replaces the `cindro` entry in place).

## systemd (user)

```bash
cp ../packaging/jarvis-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-mcp.service
```

Starts after `jarvisd.service` + `computer-use-mcp.service`.

## Tests

```bash
env -u PYTHONPATH uv run pytest
```

- Mock-daemon tests (always run): assert the `jarvis_*` tools register and that
  MCP `tools/call` of `jarvis_list_sessions` / `jarvis_start_session`
  round-trips through a fake Contract-A WS server.
- Live test (skipped if `:8795` isn't reachable): launches the real
  `cindro-mcp` in a subprocess on a test port and connects with the real MCP
  streamable-http client — `initialize` + `tools/list` (asserts `jarvis_*`
  present and `jarvis_cu_*` re-exported) + one `tools/call`
  (`jarvis_list_sessions`) against the live daemon.

## Config / env overrides

| env | default |
| --- | --- |
| `JARVIS_MCP_HOST` / `JARVIS_MCP_PORT` | `0.0.0.0` / `8797` |
| `JARVIS_MCP_TOKEN` | file `~/.config/jarvis/jarvis_mcp_token` |
| `JARVIS_CONTROL_WS` | `ws://127.0.0.1:8795/control/ws` |
| `JARVIS_CONTROL_TOKEN` | file `~/.config/jarvis/control_token` |
| `JARVIS_CU_MCP` | `http://127.0.0.1:8794/mcp` |
| `JARVIS_CU_TOKEN` | `~/.computer-use/config.yaml` `bearer_token` |
