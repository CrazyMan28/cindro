# cindro-cli — the Cindro terminal

A Claude-Code-style **terminal agent** plus the ops commands, speaking the same
Contract A control WebSocket as every other Cindro surface. Linux + Windows.

> **This is the legacy TUI.** The Python/Textual TUI described below is kept
> runnable, but is being superseded by the **TypeScript TUI v2** in
> [`../tui`](../tui) (Bun + OpenTUI/SolidJS). This Textual TUI's "/" command
> palette needed repeated patching around Textual's ancestor-only keybinding
> chain and focus handling (composer losing focus to the tab bar, Up/Down
> never reaching the popup list); v2 makes those failure modes structurally
> impossible by construction — one component owns both the input and the
> popup's selection state — rather than one-off fixes. See
> [`../tui/README.md`](../tui/README.md). The ops subcommands (`status`,
> `doctor`, `start`, `web`, `ask`, …) below are unaffected and still live here.

```
cindro                  # the full-screen TUI agent (below)
cindro status           # one-glance health snapshot of every component
cindro doctor           # deep health check — tells you what's wrong AND the fix
cindro start | stop     # headless daemon (+engine) — no GUI needed anywhere
cindro web start|stop   # the browser dashboard (web/) on :8788
cindro ask "…"          # ONE streamed turn straight to stdout (great in scripts)
cindro ask --session ID "…"   # continue that conversation
cindro sessions         # recent sessions
cindro search "…"       # full-text search across ALL chat history
cindro version          # CLI + daemon versions
```

## The TUI (`cindro` with no arguments)

Every GUI screen, in the terminal, over one streaming connection — full
parity, including live Canvas/Widget rendering, first-run onboarding, the
2FA/fingerprint lock gate, and hands-free voice mode (no more "use the
desktop app"):

The persistent main tab bar has exactly **9 tabs**:

| Tab | What it mirrors | Keys |
|---|---|---|
| Home | status + recent sessions overview | `r` refresh |
| Chat | live streamed turns: thinking, tool cards, diffs, approvals | `/` command palette · `F2` voice mode · `F3` cycle agent mode |
| Canvas | live rendered widgets as they stream in | (read-only feed) |
| Widgets | the saved widget library | `enter` render to Canvas |
| Phone | device pairing (ASCII QR) + a real dialer, active calls, and screening | `p` pair · `x` revoke · Dialer/Screening sub-tabs (see below) |
| Computer | co-work session start/stop, approvals, action log | `a` agent desktop · `w` your real screen · `s` stop · `y`/`n` approve/deny |
| Browser | the per-session in-app browser | type a URL + enter · `b`/`f` back/forward · `r` snapshot |
| Replay | step through a past session's event timeline | type a session id + enter · `j`/`k` step |
| Settings | autonomy + update knobs, plus Connectors/Policies/extension pairing | `enter` cycles a value (saves immediately) · `c` connectors · `p` policies · `e` pair browser extension |

The other **11 GUI screens** are popup-only — reachable ONLY via their `/`
slash command, which pops open an inline `QuickViewScreen` overlay (Esc to
close) on top of whatever tab you're on, rather than living in the main tab
bar:

| Popup (`/command`) | What it mirrors | Keys |
|---|---|---|
| `/sessions` | the session list | `enter` open · `n` new · `x` delete · `r` refresh |
| `/memory` | long-term memory | type to search · `enter` search · type below + `enter` remember (`#tags`) · `x` forget |
| `/skills` | skill library + usage stats | `enter` run · `p` pin/unpin · `a` archive/restore · `x` remove · `v` live/archived view |
| `/agents` | background subagents — running sessions or saved definitions | type `agent :: task` + `enter` dispatch · `v` running/defs view · `x` remove (defs view) |
| `/queue` | the durable work queue | type `title :: prompt` to enqueue · `c` cancel |
| `/activity` | the audit log tail | `r` refresh |
| `/memorygraph` | the memory relationship graph (as a tree) | type a root id + enter · `r` refresh |
| `/mcp` | configured MCP servers | `enter` enable/disable |
| `/plugins` | the signed plugin marketplace | `i` install · `enter` enable/disable · `x` remove |
| `/ssh` | the SSH allowlist | type `user@host` + enter · `x` revoke |
| `/schedules` | cron-style scheduled tasks | type `name :: prompt` to schedule · `g` run now · `x` remove |

That's still all 20 GUI screens — nothing in the desktop sidebar is
terminal-only off-limits anymore; the 11 above just aren't tabs you can
`Tab`/click between, only things you pop open and dismiss.

Global: `Ctrl+N` new chat · `F5` refresh tab · `F2` voice mode · `F3` cycle
agent mode (coworker → plan → build → …, shown live in the topbar) ·
`Ctrl+Q` quit (single press, no confirmation) · `Ctrl+C` **twice** within 2
seconds also quits — one stray Ctrl+C just arms a "press again to quit"
warning instead of killing your session, since it's the one key every
terminal habit reaches for first.

### Slash commands

Type `/` in Chat to open a fuzzy-filtered command palette — it renders
directly **above** the input line (not below it), fades in/out rather than
snapping, and the input keeps keyboard focus the whole time so typing more
of the command just keeps filtering the list. Built-ins (`/new /stop /goal
/y /n /voice` + one command per main tab above, plus `/model` and
`/provider`) plus any CUSTOM command you or Jarvis have defined.
`/canvas /widgets /phone /computer /browser /replay /home /settings` jump to
their tab; `/memory /skills /agents /queue /activity /memorygraph /mcp
/plugins /ssh /schedules /sessions` instead pop up an inline overlay (Esc to
close) without leaving Chat; `/voice` pushes the same full-screen push-to-talk
voice mode as `F2`. Ask Jarvis to make you one ("make me a /deploy command
that runs my deploy script") — it calls `create_slash_command` and it shows
up immediately, no restart needed. `prompt`-kind commands run today;
`mcp_tool`/`shell`-kind commands now execute server-side too (the daemon runs
the MCP tool or the allow-listed script and returns the result — see daemon
commit `36fa533`). `/model` and `/provider` pop up the same lightweight picker
widget the Voice tab's brain/model/voice keys reuse (`b`/`m`/`v` — see Voice
mode below).

`/stage`, `/commit`, `/revert`, and `/openpr` act on a `diff` event the model
streamed into the transcript (see "Reviewing diffs" below) and now run for
real — the daemon implements the `diff.*` verbs (git in the session workdir;
`open_pr` pushes + `gh pr create`).

### Self-editing the TUI's layout

Ask Jarvis to add/edit/remove a custom page ("add me a page that tails
/var/log/jarvis.log") — it calls `tui_add_page` (no code, a declarative
content spec: `log`/`table`/`markdown`/`widget`/`list`) and the change
appears live in every connected terminal, no restart needed. The 9 real
tabs above are reserved and can't be touched this way.

### The arc reactor and other polish

`ArcReactorWidget` is a faithful terminal recreation of the desktop GUI's
spinning-wheel `ArcReactor.qml` — not a generic spinner: it plots the same
36 rotating rim ticks, 6 counter-rotating arc segments, a rotating triangle
frame, and a pulsing core into a monospace character grid via trigonometry,
so it reads as the *same* reactor rather than a simpler stand-in. It shows up
everywhere the GUI's does:

- a big ambient **landing** reactor filling Chat's empty state until a
  conversation starts,
- a small **thinking** reactor next to the status line while a turn is in
  flight (the "orbiting dots" mode kicks in),
- a **boot/connecting** reactor in the topbar from first paint until the
  first `settings.get` round-trip resolves,
- a per-tab **loading** spinner on every pane's first data fetch (Home,
  Memory Graph, and friends).

Assistant replies **typewriter-reveal** into the transcript at a pace that
scales with message length but is capped (300ms–1.8s total) so a huge reply
never makes you wait — a fast second reply cancels any reveal still in
flight and flushes the rest straight into the permanent log instead of
leaving a half-typed line behind.

### First run and locking your desktop

**`SetupWizardScreen`** is the terminal twin of the desktop GUI's first-run
wizard — same four steps (assistant/your name, TTS voice, brain + optional
Mistral API key, permission level + auto-update), same `settings.get` /
`settings.set` calls, and critically the **same** `setup_complete` flag the
desktop app uses: finish onboarding in either front-end and the other skips
it too, they can never desync. It appears automatically on first launch,
right after the lock gate below resolves.

**`LockGateScreen`** mirrors the desktop's 2FA/fingerprint cross-device
unlock: on startup Jarvis mints a challenge and pushes your paired phone;
this screen shows "Approve on your phone…" (with a thinking reactor) and
polls until you approve with your fingerprint, or falls back to a local PIN
if one's configured. It **fails open** — no paired phone, an older daemon
that doesn't know `auth.*` yet, or an already-approved challenge all skip
the gate immediately, so you can never be locked out of your own terminal.

### Voice mode (`F2` or `/voice`)

A full push-to-talk voice conversation, right in the terminal: press
`Space` to start recording, press it again to stop and send. Your speech is
captured for real (`sounddevice`/`numpy`), sent to `voice.stt`, run as a
normal chat turn, and the reply is spoken back over your speakers via
`voice.tts` — with a whimsical rotating "thinking" phrase under the reactor
while it works, and a hard cap on recording length so a forgotten Space
press can't record forever. `b`/`m`/`v` pop up brain/model/voice pickers
(reusing the same picker widget `/model` and `/provider` use) without
leaving the screen.

### Settings sub-panels: Connectors, Policies, extension pairing

Three popups off the Settings tab, matching the desktop's own sub-sections:

- **`c` Connectors** — the Google connectors list (Calendar/Docs/Drive/Gmail):
  add one by typing `service :: client_id :: client_secret :: refresh_token`.
  Only whether each credential is *set* is ever shown; secrets never round-trip
  back from the daemon.
- **`p` Policies** — the real trust-policy engine: per-tool/per-app
  `allow`/`ask`/`deny` rules enforced at the tool layer (not just an advisory
  autonomy knob), with a cycle-able default action and per-rule action.
- **`e` Pair browser extension** — a one-paste ASCII QR pairing code for the
  Chrome extension, generated/regenerated with `g`.

### Reviewing diffs in Chat

When the model streams a `diff` event, Chat renders it inline — per-file
`+N/-M` stat chips followed by a truncated, colorized unified-diff snippet —
and `/stage <file>`, `/commit [msg]`, `/revert <file>`, and `/openpr [title]`
act on it for real. The daemon implements the `diff.*` verbs (git run in the
session's working directory; `open_pr` pushes the branch and runs
`gh pr create`), so each command reports git's own result inline.

### Phone: dialer, screening, and incoming calls

Beyond device pairing (the original `p`/`x` QR flow), the Phone tab now has
three sub-tabs: **Devices** (unchanged), **Dialer** (type an extension like
`101` to ring it, or free text to place an in-app call to you; an active-calls
table refreshes every few seconds), and **Screening** (a live view of any
AI call-screening session in progress, caller info + transcript). An
incoming-call banner pops up automatically over whichever sub-tab you're on
— **ACCEPT**/**REJECT** while it's ringing, **END CALL** once connected — the
terminal analog of the desktop's `PhoneCallOverlay.qml`.

## Install

Linux: `packaging/install.sh` does it (own venv at
`~/.local/share/jarvis/cli-venv`, `cindro` symlinked into `~/.local/bin`).

Anywhere (incl. Windows, any terminal with Python ≥3.10):

```
pip install ./cli          # from a repo checkout
cindro doctor
```

Pulls in `websockets`, `rich`, `textual`, `qrcode` (ASCII QR for the Phone
tab's pairing code), `httpx` (the Computer tab's HTTP calls into the
engine), and `sounddevice`/`numpy` (real microphone capture + playback for
Voice mode) automatically — no extra install steps.

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

172 tests: config resolution, the streaming client (per-session scoping,
broadcasts, errors), the one-shot flow (streaming, approval auto-deny), the
quick subcommands, the arc-reactor animation math, diff rendering, and
textual Pilot smoke tests of the full TUI — every tab's pane, the slash
command engine (tab-jump vs. popup vs. picker), self-edit layout hot-reload,
the setup wizard, the lock gate (including its fail-open paths), and voice
mode (recorder/player fully faked, no real audio hardware touched) — all
against a scriptable fake daemon (no live jarvisd needed).
