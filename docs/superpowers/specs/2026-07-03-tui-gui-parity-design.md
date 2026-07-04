# TUI ⇄ GUI Parity + Self-Editable Layout + Slash-Command Engine

## Goal

The `jarvis` TUI (cli/) currently mirrors 7 of the desktop app's 18 pages, and
explicitly punts on Canvas/Widgets ("use the desktop app or `jarvis web
start`"). This closes that gap completely, adds a way for the user to ask
Jarvis to reshape the TUI's own pages live (add/remove/edit — no code, just an
MCP tool), and adds a Claude-Code-style `/` command menu that both the user
and Jarvis can extend with real tool/script-backed commands.

One combined effort → one PR into `main` (confirmed with user). Sonnet-only
subagents for every implementation step (no Opus, no Fable).

## Components

### 1. Full page parity (18 GUI pages → 18 TUI screens)

Already in TUI: Chat, Sessions, Memory, Skills, Agents, Queue, Settings.
New terminal-native screens, each reusing the daemon's existing Contract-A
ops (no new backend protocol needed for these — same data the GUI pages
already fetch):

| GUI page | TUI treatment |
|---|---|
| Canvas | Real rendering via a shared canvas-op DSL renderer (see §2) |
| Widgets | Widget library list + render-on-select using the same DSL renderer |
| Phone | Device list, ASCII QR pairing (Python `qrcode` lib, no system binary), call status stream, SMS thread view |
| Computer | Live status (which=agent/real, session id, last action) + periodic single-frame snapshot via the same image/fallback path as Canvas |
| Browser | Tab list from the browser dashboard API; navigate/close |
| Activity | Scrolling tail of the daemon's event bus |
| Replay | Session timeline as a seekable/paginated text log (step fwd/back through recorded events) |
| Mcp | Configured MCP servers: list/add/remove/status |
| Plugins | Marketplace browse/install/remove (Ed25519-signed, same as desktop) |
| Ssh | SSH allowlist view/add/remove |
| MemoryGraph | Relationship graph as a Rich `Tree` (explicit text translation of the GUI's node graph, not pixel parity) |
| Home | Live dashboard: status table + recent activity + quick links |
| Schedules | Cron-style scheduled tasks: list/create/cancel (distinct from Queue's kanban) |
| Todo | Not a standalone GUI page — todo items are a *widget type* rendered inside Canvas/Widgets. Covered by §2's DSL renderer, no separate screen. |

Each screen is a Textual `Screen` subclass added to `cli/jarvis_cli/tui/`,
wired into `AppShell`'s tab bar, following the existing pattern in
`tui/screens.py`.

### 2. Canvas/Widget terminal renderer (`tui/canvas_render.py`)

Reuses the *same* op vocabulary the Android `WidgetBitmapRenderer` DSL
already defines: `text / progress / list / badge / rect / divider / chart /
svg / image`.

- `text/progress/list/badge/rect/divider/chart` → Rich primitives (Text,
  ProgressBar, Table, Panel, a small ASCII bar/sparkline renderer for chart).
- `svg/image` → detect terminal image-protocol support (kitty graphics /
  iTerm2 / sixel via `TERM`/`TERM_PROGRAM`/`KITTY_WINDOW_ID`) and render
  inline when supported; otherwise a clear `[image — open in desktop/web]`
  placeholder. No dead ends, no silent blank space.

This one renderer is shared by the Canvas screen, Widgets screen, and the
Computer screen's snapshot — one implementation, three call sites.

### 3. TUI self-editing MCP tool ("not code, just MCP")

New engine module `computer-use/computer_use_mcp/tools_tui_ops.py`
(registered alongside the existing `tools_jarvis_ops.py` self-management
tools from the WAVE 7 self-management pass), exposing:

- `tui_list_pages()`
- `tui_add_page(page_id, title, kind, config)` — `kind` ∈
  `{log, table, markdown, widget, list}`; `config` is a small declarative
  content-spec, not code
- `tui_edit_page(page_id, config)`
- `tui_remove_page(page_id)`
- `tui_reorder_pages(order)`

Backing: new Contract-A verbs `tui.layout.get/set` on the daemon (mirrors
the existing `widget.*` / `schedule.*` verb style), persisted at
`~/.config/jarvis/tui_layout.json`, broadcast on change so every connected
TUI client hot-reloads (mount/unmount) its custom pages live — same pattern
already used for live widget leases. The 18 built-in pages are reserved IDs
and cannot be removed or overwritten through this tool — only user-defined
extra pages are mutable. This means Jarvis can add/edit/remove pages when
the user asks ("add me a page that tails the error log") without ever
touching Python source.

### 4. Slash-command engine

Full script/tool-backed commands (per your choice), not just canned prompts:

- Storage: `~/.config/jarvis/commands/*.yaml` — `name`, `description`,
  `args`, and an `action` of kind `mcp_tool` (call a named MCP tool with
  templated args), `shell` (run a script under
  `~/.config/jarvis/commands/scripts/`, output streamed back like a tool
  card), or `prompt` (send a canned prompt).
- New Contract-A verbs: `command.list / command.create / command.remove /
  command.invoke`.
- Jarvis gets a matching MCP tool `create_slash_command` (same trust model
  as the existing `create_skill` tool: the agent authors the file, the user
  sees what ran) so it can register new `/` commands for itself when asked.
- TUI: typing `/` in the chat input opens a popup overlay (built-ins +
  user/agent-defined, fuzzy-filtered as you type, arrow keys + Tab/Enter to
  pick) — the same UX as your screenshot. Built-ins ported from the current
  hardcoded set (`/new /stop /goal /y /n`) plus one per new page (`/canvas
  /widgets /phone /memory /skills /agents /queue /settings /schedules /mcp
  /plugins /ssh /replay /activity /browser /computer /home`) and `/tui` for
  the self-edit tool.

### 5. Docs + delivery

- Update `cli/README.md` (page table, new commands) and the top-level
  README feature rows, following the existing per-wave doc convention (e.g.
  commit `4da9ab5`).
- **Branch note (flagging before I do it):** `dev` is currently 27 commits
  ahead of `qa`, and `qa` is 36 ahead of `main` — an existing backlog
  unrelated to this work. I will build this on a feature branch off `dev`,
  merge it into `dev`, then fast-forward `qa` to match `dev` (which brings
  that pre-existing 27-commit backlog along with it, not just this
  feature), then open the PR from `qa` into `main`. If you'd rather I
  cherry-pick *only* this feature's commits onto `qa`/`main` instead of
  dragging the backlog along, say so before I push — otherwise I'll proceed
  this way since it matches how `qa`/`main` have been promoted before (PR
  #73 was a `qa` → `main` promotion).

## Testing

- Extend `cli/tests/harness.py` (fake daemon) with the new Contract-A verbs;
  add Textual Pilot smoke tests per new screen + the slash-command popup.
- Structural unit tests for `canvas_render.py` (DSL op → Rich renderable),
  skipping image-protocol tests when no compatible terminal is detected
  (same environmental-skip pattern as `test_video_source.py`).
- Engine-side pytest for `tools_tui_ops.py` and the new `command.*` tools,
  mirroring the existing `tools_jarvis_ops.py` test pattern.
- Daemon/core tests for the new verbs (`tui.layout.*`, `command.*`).

## Execution

Implementation runs as a Workflow (ultracode-style dynamic orchestration),
Sonnet-only subagents throughout, parallelized by component (§1 pages / §2
renderer / §3 self-edit tool / §4 command engine / §5 docs), then an
integration + test pass, then the branch promotion described above.
