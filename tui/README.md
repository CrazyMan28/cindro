# jarvis-tui — the Jarvis terminal UI, v2

A TypeScript/[Bun](https://bun.sh) + [OpenTUI](https://github.com/sst/opentui) 0.3.4
(`@opentui/core` + `@opentui/solid`, SolidJS reactivity) rewrite of the Jarvis
terminal agent. It's a thin client over the same **Contract A** control
websocket every other Jarvis surface speaks (`jarvisd` on `:8795`, JSON
`{v,id,method,params}` requests / `{v,id,ok,result|error}` replies /
`{v,event,data}` broadcasts) — no logic lives here that isn't already true of
the daemon. It supersedes the Python/Textual TUI in [`../cli`](../cli), which
is now the **legacy TUI** (still runnable, see its README).

## Run in dev

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd tui
bun install
bun run dev          # bun run src/index.tsx
```

Needs a reachable `jarvisd` (`jarvis start` / `jarvis doctor` from `../cli`).
Endpoint + token resolution is a faithful port of `cli/jarvis_cli/config.py`
(`src/config.ts`): config root `$JARVIS_CONFIG_DIR` else `~/.config/jarvis`,
control token from `<config>/control_token` (or `JARVIS_CONTROL_TOKEN`),
control port from `config.toml`'s `[ports] control` (default `8795`, or
`JARVIS_CONTROL_HOST`/`JARVIS_CONTROL_PORT`).

## Build the self-contained binary

```bash
bun run build        # bun run script/build.ts -> dist/jarvis-tui
```

`bun build --compile` can't apply the Solid JSX transform on its own, so
`script/build.ts` goes through `Bun.build()` with
`@opentui/solid/bun-plugin`'s `createSolidTransformPlugin()` (minified, no
sourcemap, ESM) — the same approach OpenCode's own build script uses. Output
is one native binary at `dist/jarvis-tui`; run it directly, no `bun`/Node
needed on the target machine.

## Test

```bash
bun test             # test/*.test.ts(x) against test/mock-daemon.ts
bun run typecheck    # bunx tsc --noEmit
```

`bunfig.toml` preloads `@opentui/solid/preload` for both `bun run` and
`bun test` (the Solid JSX transform Bun has no babel preset for). Tests mount
the real component tree (`test/render.ts`, OpenTUI's test renderer) against
`MockDaemon` — an in-process Contract-A websocket stand-in (`test/
mock-daemon.ts`, the TS twin of `cli/tests/harness.py`'s `MockDaemon`) that
records every call and lets a test override per-verb handlers or inject
broadcast/session events. Coverage: the control client (reconnect/backoff,
per-session subscription scoping, the multi-subscriber broadcast bus),
command registry merge/execute, keybind resolution + remap + theme
persistence, the arc-reactor animation math, the manifest page engine
(`TablePage`/`CustomPage` helpers), full key-driven e2e passes over Chat's
`/` popup, the app shell, gates (lock/setup wizard) + voice mode, Computer +
Browser, the Phone hub + call overlay, Canvas + the saved-widget library, and
Replay + `DiffReview` (against the real `diff.*` verbs).

## Architecture

```
src/
  index.tsx           entry: boots the OpenTUI renderer, opens the ControlClient,
                       hydrates the CommandRegistry from ui.manifest, mounts <App/>
  app.tsx             app shell: topbar, tab strip, page router, palette/leader/
                       diff-review overlays, startup gates
  app-context.ts       AppContext — client, registry, navigate(), notify(), quit()
  config.ts            endpoint/token resolution (control ws url, config/data dirs)
  degrade.ts            callDegrading() — call a verb that might not exist yet on
                       an older daemon and render "not available" instead of an error
  manifest.ts           ManifestStore — reactive ui.manifest.get page list, auto-
                       refetches on ui.manifest.changed / tui.layout.changed
  engine.ts             per-session computer-use engine endpoint resolution +
                       engineFetch() REST helper shared by Computer/Browser

  control/client.ts     ControlClient — the Contract A websocket client: one reader
                       resolves per-id reply promises, fans session.event frames
                       into per-session AsyncQueues, reconnects 0.5s->15s backoff,
                       re-sends the full subscription set on reconnect. Upgrade
                       over the Python client: a MULTI-SUBSCRIBER broadcast bus
                       (on(match, fn) -> unsubscribe) instead of one bare slot.

  commands/registry.ts  CommandRegistry — ONE command table driving keybinds, the
                       Ctrl+K palette, and the "/" slash menu. Merges local (UI-
                       owned run() closures), manifest (daemon-described builtins),
                       and custom (source:"custom", executed via command.invoke)
                       entries; locals always win name collisions.
  commands/keybinds.ts  Keybind defaults + ~/.config/jarvis/tui.json remap loading

  chat/                 Composer (input + inline "/" popup), Transcript, Picker
                       (brain/model/voice), DiffReview, session.ts (SessionController
                       — session.create/subscribe, event pump, ask_user file bus)
  pages/                Home, Chat, Canvas, Widgets, Computer, Browser, Voice,
                       Replay, Settings — the bespoke builtin pages
  pages/engine/         the manifest-driven generic renderers: TablePage (any
                       manifest "table" page — data verb + columns + row/page/
                       input actions, zero per-feature frontend code) and
                       CustomPage (Jarvis-authored log|table|markdown|widget|list
                       pages from tui_add_page), plus types.ts (shared shapes +
                       pure helpers: substituteParams, formatCell, columnWidths)
  phone/                the 6-tab Phone hub (PhonePage) + tabs/*, CallOverlay
                       (app-wide incoming/active-call banner), api.ts (phone.mcp/
                       phone.http proxy calls)
  gates/                LockGate (2FA/fingerprint cross-device unlock, fail-open),
                       SetupWizard (first-run onboarding, shares setup_complete
                       with the GUI)
  widgets/              Widget.tsx (the DSL renderer) + store.ts (CanvasStore +
                       the saved-widget library, same saved_widgets.json as desktop)
  ui/                   ArcReactor (+ arc-reactor.ts painter), Topbar (HUD status
                       strip), Palette (Ctrl+K), WhichKey (leader cheat sheet),
                       Toasts, sysstats.ts (live /proc CPU/RAM/NET for Home)
  theme/                tokens.ts (hex palette) + index.ts (resolved RGBA theme,
                       accent cycling + persistence, markdown/code SyntaxStyle)
  voice/audio.ts        record/play via arecord/aplay (or pw-play), swappable
                       spawnImpl so tests never touch real audio hardware
```

Every builtin page/pane is a documented, deliberate **port** of its GUI or
legacy-TUI counterpart (each file's header comment says which QML file or
`cli/jarvis_cli/tui/*.py` module it mirrors, and calls out any deliberate
upgrade) — nothing here is invented parity.

## Keybinds

- **Ctrl+K** — global fuzzy command palette (any command in the registry, from
  any screen).
- **leader (`ctrl+x`)** — a which-key overlay lists every leader-bound action;
  press the follow key within 2s. Defaults: `e` export transcript, `t` cycle
  theme, `l` sessions, `n` new chat, `?` help.
- **F2** (or `/voice`) — voice mode.
- **Alt+1..9** — jump to a main tab (Meta/Option+digit; Ctrl+digit doesn't
  encode reliably, and bare digits belong to composers/pickers).
- **Ctrl+Q** — quit.

All of the above are remappable: `~/.config/jarvis/tui.json`
`{ "keybinds": { "<action>": "<key-string>" | null } }` overrides
`DEFAULT_KEYBINDS` in `src/commands/keybinds.ts` (`null` unbinds an action).
Key strings are normalized `"ctrl+k"` / `"f2"` / `"leader n"`.

Theme: **leader t** cycles the accent color (cyan → amber → violet →
emerald) by recoloring the shared `theme` RGBA objects in place, and persists
the choice to `~/.config/jarvis/tui.json` as `{ "accent": "<name>" }`
(`src/theme/index.ts`); it's restored via `loadSavedAccent()` at boot.

## Features

- **Chat** with a fixed composer and an inline `/` command popup floated
  *above* the input (never below) — one focused `<input>` owns both typing
  and popup Up/Down/Tab/Escape, so the popup can never steal focus or eat a
  keystroke.
- **9 main tabs** (Home, Chat, Canvas, Widgets, Phone, Computer, Browser,
  Replay, Settings) **+ 11 `ui.manifest`-driven data pages** (Sessions,
  Memory, Memory Graph, Skills, Agents, Queue, Activity, MCP, Plugins, SSH,
  Schedules) rendered by the generic `TablePage` as overlay routes, **+ any
  number of custom pages** Jarvis authors live via `tui_add_page`.
- **Phone hub**: 6 tabs (Calls, Agents, Inbox, HUD, Settings, Screening,
  cycled with `[`/`]`) plus an app-wide incoming/active-call overlay
  (accept/reject/end).
- **Canvas / Widgets / Home dashboard**: a live ad-hoc widget feed, a saved
  widget library, and a Home dashboard with a hero arc-reactor card, live
  CPU/RAM/NET history bars from `/proc`, recent sessions, pinned widgets
  (reorderable), and the manifest page directory.
- **Computer / Browser**: start/stop a co-worker on the nested agent
  desktop or take over the real screen (confirm-gated), approvals, an
  action log, and a text DOM-snapshot browser pane that drives the
  per-session engine's `/browser/*` REST routes.
- **Settings**: master-detail terminal edition of the full GUI Settings
  page — every daemon param verified against `SettingsPage.qml`/
  `ControlServer.cpp`.
- **Voice** (`F2`): push-to-talk (Space to start/stop; the GUI's hands-free
  duplex has no sane terminal equivalent) through `voice.stt`/`voice.tts`,
  with brain/model/voice pickers (`b`/`m`/`v`).
- **Replay**: scrub a past session's full event history like a video,
  rebuilding the transcript per seek through a private `SessionController`.
- **Diff review**: per-file stat-chip cards with a truncated colorized
  unified diff, and `stage`/`commit`/`revert`/`openpr` actions against the
  daemon's real `diff.*` verbs.

See [`docs/UI_MANIFEST.md`](../docs/UI_MANIFEST.md) for how the manifest-driven
pages and custom commands work end to end.
