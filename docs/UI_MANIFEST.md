# UI Manifest — the shared-surface contract

`ui.manifest` is the daemon-owned, single declarative description of every
user-facing surface — pages, slash commands, settings knobs, status-strip
segments — that **both frontends** (the desktop QML sidebar and the terminal
TUI v2) render from. The point: a feature lands in the manifest **once** and
shows up in both UIs, instead of being hand-built twice and drifting apart.

Owned by `core/include/jarvis/UiManifest.h` + `core/src/UiManifest.cpp`
(`jarvis::UiManifest::base()` / `::merged()`), served by the daemon
(`daemon/src/ControlServer.cpp`, `ControlServer::handleUiManifestGet`).

## The verb + the broadcast

```
ui.manifest.get      -> { v, pages[], commands[], settings_sections[], status_segments[] }
ui.manifest.changed  -> (no payload) — clients refetch ui.manifest.get
```

`ui.manifest.get` returns `UiManifest::merged(customPages, customCommands)`:
the compiled-in `base()` JSON (parsed once, cached) with the live
`TuiLayoutStore` custom pages and `CommandStore` custom commands appended,
each tagged `"source": "custom"`.

`ui.manifest.changed` is a **payload-free nudge** — the daemon broadcasts it
to every connected client and each client just re-calls `ui.manifest.get`,
rather than double-encoding the whole manifest on every change. The daemon
fires it whenever a custom page or custom command is added/edited/removed
(`ControlServer::broadcastUiManifestChanged()`, called from the
`tui.layout.add/edit/remove/reorder` handlers and from custom-command
create/remove). Older daemons only broadcast the pre-existing
`tui.layout.changed` event for page edits — clients that care listen to
**both** (refetching is idempotent either way).

On the TS TUI side, `tui/src/manifest.ts`'s `ManifestStore` is the consumer:
it calls `ui.manifest.get` once at boot and again on either broadcast,
exposing a reactive `pages()` signal plus `page(id)`, `customPages()`, and
`tablePages()` accessors.

## Page kinds

Every page in `pages[]` has an `id`, `title`, `section`, and `kind`:

| `kind` | Who renders it | What it means |
|---|---|---|
| `"table"` | generic — **zero per-feature frontend code** | a list page: one `data` verb + `columns[]` + row/page/input actions. A frontend renders it with ONE generic table-page component (`TablePage` on the TUI). Today: Sessions, Memory, Skills, Agents, Queue, Schedules, Activity, MCP, Plugins, SSH. |
| `"bespoke"` | hand-built on each frontend | a page with real custom UI (Home, Chat, Voice, Computer, Browser, Canvas, Widgets, Phone, Memory Graph, Replay, Settings). The manifest still owns its `id`/`title`/`section` so navigation, palettes, and `/commands` stay in sync across frontends even though the page body isn't generic. |
| `"log"` \| `"table"`\* \| `"markdown"` \| `"widget"` \| `"list"` | generic, **custom-page only** | the declarative content kinds an Orin-authored custom page (`tui_add_page`/`tui_edit_page`, i.e. `TuiLayoutStore`) can be — see below. |

\* a custom page's own `"table"` kind is a *static* table (fixed `columns`/
`rows` in its `config`), distinct from the builtin `"table"` kind above (which
is *live*, backed by a daemon verb).

### Declaring a `"table"` page (the zero-frontend-code path)

A table page's shape, straight from `core/src/UiManifest.cpp`:

```jsonc
{
  "id": "schedules", "title": "Schedules", "section": "mind", "kind": "table",
  "data": {
    "list": { "verb": "schedule.list", "result_key": "schedules" }
    // an optional second entry (e.g. "search" or "archived") becomes the
    // TablePage 'a' alternate-source toggle; a "search" entry with a
    // query_param becomes the 'f' search action
  },
  "columns": [
    { "key": "name",     "label": "Job" },
    { "key": "next_run", "label": "Next", "format": "reltime" },
    { "key": "enabled",  "label": "On",   "format": "flag" }
  ],
  "row_actions": [
    { "id": "run_now", "label": "Run now", "kind": "verb", "verb": "schedule.run_now",
      "params": { "id": "$id" } },
    { "id": "toggle",  "label": "Enable/disable", "kind": "verb",
      "verb": "schedule.set_enabled", "params": { "id": "$id", "enabled": "$toggle" } },
    { "id": "remove",  "label": "Remove", "kind": "verb", "verb": "schedule.remove",
      "params": { "id": "$id" }, "confirm": true }
  ],
  "input_actions": [
    { "id": "add", "placeholder": "Queue a task…", "kind": "verb",
      "verb": "schedule.add", "params": { "title": "$input" } }
  ]
}
```

- **`data`** maps a source key to `{ verb, result_key, params?, query_param? }`
  — the frontend calls `verb`, pulls the row array out of the reply at
  `result_key`, merging in any fixed `params`.
- **`columns`** declare `key` + `label` + an optional `format`
  (`reltime`/`time`/`flag`/`chips`/`risk`) a frontend uses to render the cell
  consistently everywhere (e.g. `reltime` → "3m ago" / "in 2h").
- **`row_actions`** run against the selected row; **`page_actions`** run
  against no row (e.g. "New chat"); **`input_actions`** prompt for free text
  first (e.g. "Remember this…").
- Action `params` support `$`-prefixed substitution against the row:
  `"$id"` → `row.id`, `"$name"` → `row.name`, `"$input"` → the typed text,
  `"$toggle"` → `!row.enabled` (or whichever field the action names). This is
  `substituteParams()` in `tui/src/pages/engine/types.ts`.
- `"when": "archived"` / `"when": "!builtin"` gates an action's visibility on
  a row flag (`actionVisible()`); `"confirm": true` requires a yes/no step
  first; `"show": "detail"` renders the verb's raw JSON reply instead of
  refreshing the row list (used for Skills/Agents "View").
- `refresh_events` lists broadcast names that should trigger a re-fetch
  (throttled) — e.g. Sessions refetches on `session.opened`.

Ship a new daemon feature in this shape — a list verb + a few actions — and
it appears as a full page on **every** frontend with **no new frontend code**
at all: just an entry in `kBaseManifest`.

## Custom pages and custom commands (`source: "custom"`)

Two independent Orin-authored mechanisms merge into the same manifest at
request time, both tagged `"source": "custom"` so frontends know not to treat
them as part of the fixed builtin set:

- **Custom pages** — `tui.layout.add/edit/remove/reorder` (backed by
  `TuiLayoutStore`, unchanged/verbatim — this generalizes `tui.layout.*`
  rather than replacing it). A custom page's `kind` is one of `log` (tail a
  file), `table` (static rows), `markdown`, `widget` (the full widget DSL),
  or `list` — no code, just a declarative `config` blob. On the TS TUI,
  `CustomPage.tsx` renders whichever kind it is; these pages also show up as
  live, sparkle-marked (`✦`) tabs in the top bar (`manifest.customPages()`
  in `app.tsx`), not just as popup routes.
- **Custom commands** — Orin- or user-authored slash commands
  (`create_slash_command`, backed by `CommandStore`), merged into
  `commands[]` with `kind` one of `prompt` (returns text to send as a chat
  turn), `mcp_tool`, or `shell` (both executed daemon-side via
  `command.invoke` and returning `{executed, ok, output}`). `CommandRegistry
  .mergeManifest()` on the TS TUI treats any entry whose `source` is
  `"custom"` (or whose `kind` is one of those three) as custom, and never
  lets it collide with a `"local"` (UI-owned) registration.

Both `tui.layout.*` mutations and custom-command create/remove call
`ControlServer::broadcastUiManifestChanged()` — a client hydrating its
command registry / page list from `ui.manifest.get` after boot never needs a
restart to see either kind of addition.

## `status_segments` and `settings_sections`

`status_segments[]` describes the HUD status strip (`link` connection dot,
`version`, `default_brain`, `agent_mode`, live `mcp.enabled`/`agents_running`
counts) — each frontend's status bar (GUI `HudStatusStrip`, TUI `Topbar`)
reads the same segment list rather than hardcoding which counters exist (the
TUI's `Topbar` used to hardcode `mcpCount=1` for months before `status.get`
existed; this is the fix class).

`settings_sections[]` groups settings knobs (`id`, `label`, `type`:
`enum`/`toggle`, `choices?`) under a titled section (e.g. "Mode & autonomy":
`agent_mode`, `permission_level`, `self_improve`, `auto_continue`,
`wake_notify`, …) — enough for a frontend to render a generic settings list;
today the GUI's `SettingsPage.qml` and the TUI's `Settings.tsx` are still
hand-built (bespoke, richer widgets per knob type), but both are validated
against this same knob set so they can never drift apart on what exists.

## Who owns what, and what's left

- **The daemon owns the manifest.** `core/` defines the schema and the
  compiled-in builtin JSON; `daemon/` serves it and merges in live custom
  state. Neither frontend invents its own idea of what pages/commands exist.
- **The TS TUI (`tui/`) is a full consumer today**: `src/manifest.ts`
  (`ManifestStore`) + `src/pages/engine/` (`TablePage`, `CustomPage`,
  `types.ts`) render every table/custom page generically, and
  `src/commands/registry.ts` hydrates the palette/slash-menu/keybind surface
  from `commands[]`.
- **The desktop GUI does not yet consume it.** There is no
  `ManifestPage.qml` — the QML sidebar's pages are still each hand-built
  independently of `ui.manifest`. Completing the vice-versa direction (a
  generic `ManifestPage.qml` that renders `"table"` pages the same way the
  TUI's `TablePage` does) would close the loop: a new feature shipped only as
  a manifest entry would then appear on **both** frontends with zero
  additional frontend code on either side, instead of just the TUI's.
