# jarvis-cli — the Jarvis terminal

A Claude-Code-style **terminal agent** plus the ops commands, speaking the same
Contract A control WebSocket as every other Jarvis surface. Linux + Windows.

```
jarvis                  # the full-screen TUI agent (below)
jarvis status           # one-glance health snapshot of every component
jarvis doctor           # deep health check — tells you what's wrong AND the fix
jarvis start | stop     # headless daemon (+engine) — no GUI needed anywhere
jarvis web start|stop   # the browser dashboard (web/) on :8788
jarvis ask "…"          # ONE streamed turn straight to stdout (great in scripts)
jarvis ask --session ID "…"   # continue that conversation
jarvis sessions         # recent sessions
jarvis search "…"       # full-text search across ALL chat history
jarvis version          # CLI + daemon versions
```

## The TUI (`jarvis` with no arguments)

Every GUI screen, in the terminal, over one streaming connection — full
parity, including live Canvas/Widget rendering (no more "use the desktop
app"):

| Tab | What it mirrors | Keys |
|---|---|---|
| Home | status + recent sessions overview | `r` refresh |
| Chat | live streamed turns: thinking, tool cards, approvals | `/` opens the command palette |
| Sessions | the session list | `enter` open · `n` new · `x` delete |
| Memory | long-term memory | type to search · `x` forget |
| Skills | skill library + usage stats | `enter` run · `p` pin · `v` archived · `a` restore |
| Agents | background subagents | `r` refresh |
| Queue | the durable work queue | type `title :: prompt` to enqueue · `c` cancel |
| Schedules | cron-style scheduled tasks | type `name :: prompt` to schedule · `g` run now · `x` remove |
| Settings | autonomy + update knobs | `enter` cycles a value (saves immediately) |
| Canvas | live rendered widgets as they stream in | (read-only feed) |
| Widgets | the saved widget library | `enter` render to Canvas |
| Phone | device pairing (ASCII QR) + list | `p` pair · `x` revoke |
| Computer | co-work session start/stop, approvals, action log | `a` agent desktop · `w` your real screen · `s` stop |
| Browser | the per-session in-app browser | type a URL + enter · `b`/`f` back/forward · `r` snapshot |
| Activity | the audit log tail | `r` refresh |
| Replay | step through a past session's event timeline | type a session id + enter · `j`/`k` step |
| Mcp | configured MCP servers | `enter` enable/disable |
| Plugins | the signed plugin marketplace | `i` install · `enter` enable/disable · `x` remove |
| Ssh | the SSH allowlist | type `user@host` + enter · `x` revoke |
| MemoryGraph | the memory relationship graph (as a tree) | type a root id + enter |

Global: `Ctrl+N` new chat · `F5` refresh tab · `Ctrl+Q` quit.

### Slash commands

Type `/` in Chat to open a fuzzy-filtered command palette — built-ins
(`/new /stop /goal /y /n` + one command per tab above, plus `/model` and
`/provider`) plus any CUSTOM command you or Jarvis have defined.
`/canvas /widgets /phone /computer /browser /replay /home /settings` jump
to their tab; `/memory /skills /agents /queue /activity /memorygraph /mcp
/plugins /ssh /schedules /sessions` instead pop up an inline overlay
(Esc to close) without leaving Chat. Ask Jarvis to make you one
("make me a /deploy command that runs my deploy script") — it calls
`create_slash_command` and it shows up immediately, no restart needed.
`prompt`-kind commands run today; `mcp_tool`/`shell`-kind commands are
recognized but notify rather than auto-execute (direct in-TUI dispatch is
a fast-follow — see docs/superpowers/plans/2026-07-03-tui-gui-parity.md).

### Self-editing the TUI's layout

Ask Jarvis to add/edit/remove a custom page ("add me a page that tails
/var/log/jarvis.log") — it calls `tui_add_page` (no code, a declarative
content spec: `log`/`table`/`markdown`/`widget`/`list`) and the change
appears live in every connected terminal, no restart needed. The 20 tabs
above are reserved and can't be touched this way.

## Install

Linux: `packaging/install.sh` does it (own venv at
`~/.local/share/jarvis/cli-venv`, `jarvis` symlinked into `~/.local/bin`).

Anywhere (incl. Windows, any terminal with Python ≥3.10):

```
pip install ./cli          # from a repo checkout
jarvis doctor
```

Pulls in `websockets`, `rich`, `textual`, `qrcode` (ASCII QR for the Phone
tab's pairing code), and `httpx` (the Computer tab's HTTP calls into the
engine) automatically — no extra install steps.

## Configuration

Zero-config against a local daemon: the CLI reads
`~/.config/jarvis/control_token` + the `[ports] control` from `config.toml`
(honoring `JARVIS_CONFIG_DIR` profiles). Overrides: `JARVIS_CONTROL_WS`,
`JARVIS_CONTROL_TOKEN`, `JARVIS_CONTROL_HOST/PORT`.

## Tests

```
cd cli && python -m venv .venv && .venv/bin/pip install -e . pytest pytest-asyncio
.venv/bin/python -m pytest tests
```

47 tests: config resolution, the streaming client (per-session scoping,
broadcasts, errors), the one-shot flow (streaming, approval auto-deny), the
quick subcommands, and textual Pilot smoke tests of the TUI (boot, chat
round-trip, sessions, settings cycling) — all against a scriptable fake
daemon (no live jarvisd needed).
