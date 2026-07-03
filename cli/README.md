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

Every GUI screen, in the terminal, over one streaming connection:

| Tab      | What it mirrors | Keys |
|----------|-----------------|------|
| Chat     | live streamed turns: thinking, tool cards, approvals | `/new` `/stop` `/goal …` `/y` `/n` |
| Sessions | the session list | `enter` open · `n` new · `x` delete |
| Memory   | long-term memory | type to search · `x` forget |
| Skills   | skill library + usage stats | `enter` run · `p` pin · `v` archived · `a` restore |
| Agents   | background subagents | `r` refresh |
| Queue    | the durable work queue | type `title :: prompt` to enqueue · `c` cancel |
| Settings | autonomy + update knobs | `enter` cycles a value (saves immediately) |

Global: `Ctrl+N` new chat · `F5` refresh tab · `Ctrl+Q` quit. Approvals stream
into Chat as red cards — `/y` allows, `/n` denies. Canvas widgets surface as
labeled transcript lines (the Canvas itself is inherently graphical; use the
desktop app or `jarvis web start`).

## Install

Linux: `packaging/install.sh` does it (own venv at
`~/.local/share/jarvis/cli-venv`, `jarvis` symlinked into `~/.local/bin`).

Anywhere (incl. Windows, any terminal with Python ≥3.10):

```
pip install ./cli          # from a repo checkout
jarvis doctor
```

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

16 tests: config resolution, the streaming client (per-session scoping,
broadcasts, errors), the one-shot flow (streaming, approval auto-deny), the
quick subcommands, and textual Pilot smoke tests of the TUI (boot, chat
round-trip, sessions, settings cycling) — all against a scriptable fake
daemon (no live jarvisd needed).
