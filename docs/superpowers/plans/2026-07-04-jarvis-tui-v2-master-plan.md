# Orin TUI v2 (TypeScript/OpenTUI) — Master Plan

> **For agentic workers:** This is the MASTER plan (architecture + phases + parity contract).
> Each phase gets its own bite-sized implementation plan (superpowers:writing-plans format,
> saved next to this file as `2026-MM-DD-tui-v2-phase-N-*.md`) written when that phase starts.
> Execute those with superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Replace the janky Python/Textual TUI with a TypeScript TUI (OpenTUI + SolidJS, same stack as OpenCode) that has 100% feature parity with the desktop GUI, fixes every known TUI bug, adopts the best Claude Code / OpenCode interaction patterns, and — via a daemon-owned surface contract — makes every future feature appear in BOTH GUI and TUI automatically.

**Architecture:** Thin-client TUI over the existing jarvisd websocket (Contract A, `{v:1,id,method,params}` frames — unchanged). SolidJS reactivity over OpenTUI's 60fps cell renderer; a single declarative command table drives keybindings + command palette + slash menu; a daemon-published *surface manifest* drives generic pages/settings/commands on both frontends so features ship once.

**Tech Stack:** Bun + TypeScript, `@opentui/core` / `@opentui/solid` / `@opentui/keymap` **pinned 0.3.4** (same as OpenCode 1.17.x), solid-js, fuzzysort. Shipped as a self-contained binary via `bun build --compile` (end users need no bun/node — node is only already required for the phone server).

## Global Constraints (NON-NEGOTIABLE)

- **NEVER remove a feature.** Every feature in the current GUI *and* the current Python TUI must exist in TUI v2 (Appendix A is the checklist). Terminal-impossible features get a documented terminal translation, never silent omission.
- **Arc reactor + HUD top bar stay** — and get BETTER (framebuffer renderable, full HudStatusStrip telemetry).
- **Custom Orin-authored pages stay** (`tui.layout.list` + `tui.layout.changed` diff-reconciliation loop, kinds log/table/markdown/widget/list). This mechanism is load-bearing and must survive byte-for-byte in behavior.
- **Old Python TUI is not deleted** until the Appendix-A parity gate passes and the user signs off. It stays runnable as `jarvis tui --legacy`.
- Widget DSL button actions remain strictly allow-listed (`{send}` or `{skill,args}` only — nothing eval'd); link nodes stay scheme-guarded (http/https).
- Session-scoping discipline (session_id filters on every event consumer) is a hard invariant — one session's content must never leak into another's view.
- Branch flow: work on `dev` → `/code-review` + fix all findings → push dev → qa → PR to `main` (main is protected, PR-only; user merges).
- Daemon protocol changes are **additive only** (old GUI/TUI clients keep working).

---

## 1. The hard decision: Python/Textual → TypeScript/OpenTUI. Verdict: PORT.

**Why the current TUI is unfixable-in-place (evidence from forensic audit, scripted Pilot tests):**

1. **`/` bug root cause A:** `#chat-input` is focused nowhere except one path (app.py:405 via Sessions). Textual's `AUTO_FOCUS='*'` lands focus on the tab bar at startup; `/` is silently swallowed. Empirically confirmed.
2. **`/` bug root cause B — the framework one:** Textual resolves key bindings only through `focused.ancestors_with_self`. The palette's ListView is a *sibling* of the Input, so Up/Down/Enter can **structurally never** reach it while the input has focus. `ListView.index` stays `None` under any number of key presses. The mouse workaround is also broken (click steals focus → Enter resolves through ListView's own binding → nothing runs). There is *no* working way to pick a palette entry today.
3. Single-slot `on_broadcast_extra` (bare assignment) — only ONE pane app-wide can receive push events; CanvasPane owns it, so PhonePane polls on 3-4s timers. Mount-order-dependent silent breakage.
4. Confirmed dead verbs called by UI: `schedule.run_now` ("g" key always errors), `diff.*` (all four slash commands are vapor).
5. Widespread bare `except Exception: pass` swallowing real bugs; ComputerPane leaks its pump task on unmount; Escape can't even close the palette.

Fixing A+B in Textual means rebuilding focus + key routing against the grain of the framework — i.e. a rewrite anyway, in the framework that caused the bug.

**Why OpenTUI/Solid specifically (verified in OpenCode's source, not marketing):**

- **The exact `/` fix exists as a first-class pattern:** OpenCode's autocomplete registers a second keybinding layer *on the same focused textarea*, gated by `enabled: () => popupVisible` — Up/Down/Tab/Enter shadow the editor's bindings while the composer keeps focus (autocomplete.tsx + `computePromptTraits` capture lists). No focus dance, no sibling-binding problem.
- **One command object → three surfaces** (keybinding + palette entry + slash name/aliases) — kills the "TUI commands are stubs of GUI commands" drift class.
- Mode stack + leader key + which-key + ~150 remappable named bindings (`@opentui/keymap`).
- **FrameBufferRenderable with frame-cache** (OpenCode's bg-pulse: precompute ~30fps of frames into typed arrays, blit per render) — tailor-made for a *better* ArcReactor than the Rich-text one.
- Flexbox layout, mouse (click/scroll/right-click-copy), extmark textarea chips (mentions/attachments), scrollbox, OSC52+native clipboard chain, OS notifications + sound packs, theme system with terminal-bg auto-detection.
- Ecosystem: production-proven by OpenCode; TS matches Claude Code; the team's AI tooling writes TS fluently.

**Runtime/packaging reality check (verified):** `bootstrap-install.sh` already installs node+npm on every distro; Windows edition already bundles portable Node. Bun is a *build-time* dep only — we ship compiled binaries.

**Risks + mitigations:**
- OpenTUI is 0.3.4 (pre-1.0, API churn) → pin exactly 0.3.4, vendor a `patches/` dir like OpenCode does, copy their `upgrade-opentui` script pattern for controlled bumps.
- Terminal image support unconfirmed in OpenTUI → we emit Kitty graphics / iTerm2 escape sequences ourselves behind capability detection (any TUI can passthrough-write); fallback = current text placeholder. Image rendering is *additive* over today's TUI (which renders nothing).
- We do NOT copy OpenCode code. We copy *patterns* (binding layers, command table, slots, dialog stack, docked prompts) with our own implementation against jarvisd's protocol. License is MIT either way, but this codebase stays ours.

---

## 2. Shared GUI↔TUI contract (the "add once, appears in both" architecture)

Today a feature = daemon verbs + hand-written QML page + hand-written Textual pane. That triple-write is why the TUI drifted. Target state:

**2a. Daemon surface manifest (new, additive):**
- New verbs `ui.manifest.get` and broadcast `ui.manifest.changed` (generalization of today's `tui.layout.list`/`tui.layout.changed`, which stay for compat).
- The manifest declares, per feature: **pages** (id, title, icon, nav section, kind: `table|log|markdown|widget|list|custom`, data verbs + refresh events, row actions), **commands** (name, description, args schema, kind: verb/prompt/navigate), **settings sections** (knob id, label, type enum/toggle/text/secret, verb), **status segments** (id, label, value source verb/event) for the HUD strip.
- Both frontends implement ONE generic renderer per page kind + generic settings/commands/status consumers. A new daemon feature that fits these kinds ships with **zero frontend code** — the tab, the `/command`, the palette entry, and the settings section appear in GUI *and* TUI automatically. This is the custom-pages mechanism promoted from side-feature to primary delivery path.
- Features needing custom visuals declare a payload type; each frontend registers a renderer for it (widget DSL is the existing proof this works).

**2b. One command registry:** `command.list` extended to return builtins with metadata (today it's customs only); frontends merge daemon commands + local UI commands into their single declarative command table. Custom command kinds `mcp_tool` and `shell` get real daemon-side execution (today `command.invoke` returns them and the TUI just notifies "fast-follow").

**2c. Event bus, fixed:** TS ControlClient exposes `subscribe(eventPrefix, handler)` multi-subscriber pub/sub (replaces the single-slot `on_broadcast_extra` landmine). Daemon side unchanged.

**2d. Shared design tokens:** one `design/tokens.json` (colors incl. the two cyans, risk colors, motion durations, ring periods) generated into `Theme.qml` (GUI) and `theme/jarvis.json` (TUI default theme). Changing the brand once changes both.

**GUI follow-up (separate small plan, after v2):** teach the QML side to consume `ui.manifest` pages via a generic `ManifestPage.qml` — that completes the vice-versa direction.

## 3. Daemon fixes required regardless of frontend (Phase 0)

1. **Implement `diff.*`**: `diff.stage`, `diff.commit`, `diff.revert`, `diff.open_pr` + emit `diff`-kind session events when the agent edits files. (Unblocks GUI DiffReviewPanel AND TUI /stage /commit /revert /openpr — both are dead today.)
2. **Add `schedule.run_now`** verb (GUI's Run button + TUI's "g" both call a verb that doesn't exist in ControlServer.cpp's dispatch table).
3. **Execute `mcp_tool`/`shell` custom commands** in `command.invoke` (with policy/approval gating like any tool call).
4. **Live MCP/agent telemetry** for the HUD strip (GUI's `mcpCount` is a hardcoded `1` today).
5. `ui.manifest.get`/`ui.manifest.changed` (section 2a) + extend `command.list` (2b).
6. Verb inventory + exact registration points: **see Appendix B** (from daemon audit).

## 4. What TUI v2 contains (feature surface)

**4a. Everything the GUI has** — the 19 nav pages + Phone hub (6 sub-tabs + app-wide call overlay) + the 3 gate screens (LockGate, SetupWizard, VoiceMode) + chat's full 9 message kinds (message / widget / tool unified / tool_call / tool_result / diff / approval / question / error) with typewriter streaming, collapsible tools, docked Allow/Always/Deny + question forms. Appendix A is the binding checklist (ported/partial/missing from the audit matrix — every line must be ✅ or have a documented terminal translation).

Highlights that close today's worst gaps:
- **Home = GUI Home**: greeting, connection pill, hero active-agent card, quick-action chips, recent sessions, CPU/RAM/GPU/NET sparkline cards, pinned widgets with reorder/unpin.
- **Widget DSL full parity**: all 16 node types incl. `image` (Kitty/iTerm2 graphics behind capability detect), `svg` (rasterize→graphics where supported, else structured text), `button`/`link` **interactive** (focusable, Enter/click fires allow-listed action), `pager` with real next/prev, `anim` (pulse/fade/spin/float/blink via frame ticks). Renders inline in chat, in Canvas (cap 20, newest-top, save/pop-out-to-route/delete), Widgets library (→Chat/→Canvas/📌Home/delete), pinned on Home, and a FloatingWidgetLayer analog: a toggleable right-hand **widget dock** in Chat/Voice.
- **Phone hub complete**: CALLS (quick-dial chips, keypad, PSTN/in-app toggle, active-call cards w/ state dots), AGENTS (roster + voice/model/emotion/rate config), INBOX (threads, bubbles, quiz-option replies, compose, new-chat), HUD (6-card ops grid, activity log, **Red Alert**), SETTINGS (diagnostics 6-check, call history, Twilio/SMS/user-number, screening + carrier codes with the *user's real number* — fixing the GUI's hardcoded placeholder bug, allowlist, enroll agent, war room), SCREENING (live transcript) — plus **global** incoming-call overlay visible from any tab.
- **Computer**: brain/model picker, confirm-gated real-screen takeover, transcript rendered by the *same* chat renderer (approvals inline), DRIVING beacon.
- **Browser**: URL/nav, DOM snapshot with **clickable refs**, optional live screenshot via terminal graphics.
- **Settings**: every GUI section — Identity, Defaults + Claude account picker, Voice (STT/TTS providers, named voice library, record/upload), **API keys (9 providers, masked)**, Appearance/Security (**PIN set/clear**), Mode/Autonomy/Permissions, Trust policies, Updates (check/update now), Extension pairing, Connectors, Devices.
- **SSH**: allowlist + the gated exec console with per-command transcript.
- **Voice mode**: continuous conversation (daemon `startConversation` like the GUI) + push-to-talk fallback, full thinking-phrase pool, widget dock beside the orb.
- Sessions/Memory/MemoryGraph/Skills/Agents/Queue/Activity/Replay/MCP (incl. CLI-brain servers section)/Plugins/Schedules — as manifest-driven pages with all GUI row actions (two-step delete confirms, view/create dialogs, replay transport controls incl. widget-kind rendering that the GUI's Replay itself lacks).

**4b. Everything the current Python TUI has** that the GUI doesn't: custom pages (tui.layout.*), F3 mode cycle, ASCII QR pairing, `call_degrading` graceful-degrade UX, ctrl+c press-again quit guard, MockDaemon-style test harness (ported).

**4c. Stolen from Claude Code / OpenCode (curated for Orin, no daemon changes unless noted):**
- Composer: inline `/` popup done right, `@` mentions (sessions/skills/agents/memories via fuzzysort + frecency), prompt history (↑/↓ at buffer edges) + stash, `Ctrl+G` $EDITOR round-trip, big-paste collapse chip, image paste → attachment (daemon permitting).
- Command layer: `Ctrl+K` global fuzzy palette, leader key (default `ctrl+x`) + **which-key overlay**, fully remappable `~/.config/jarvis/tui.json` keybinds, Escape closes any popup — always.
- Transcript: collapsible thinking + tool outputs, QUEUED badge, compaction divider, jump-to-message timeline, copy/export transcript (markdown), `Ctrl+O`-style detail toggle.
- Sessions: subagent tree navigation (parent/child/sibling keys — SubAgentTree parity), pinned sessions + quick slots, session rename.
- Chrome: toasts, OS notifications + sounds gated by terminal focus, terminal-title sync, mouse everywhere (tabs, scroll, right-click copy, click-to-expand), theme JSON system (jarvis default + terminal-adaptive `system` theme + user themes dir), degrade for non-truecolor terminals.

---

## 5. Phases (each = its own bite-sized plan + review gate + promotable state)

- **Phase 0 — Daemon contract & fixes** (section 3). Deliverable: verbs live + tested via ctest; old TUI's `/stage` etc. start working, proving the contract before any TS exists.
- **Phase 1 — Scaffold**: `tui/` package (bun, pinned opentui), TS ControlClient (protocol port of control.py: per-id futures, reconnect+resubscribe, **multi-subscriber event bus**), theme tokens + jarvis theme, ArcReactor framebuffer renderable, topbar HUD strip (live telemetry), tab shell + router, command-table engine, degrade helper, test harness (MockDaemon TS port). Gate: boots, connects, Home skeleton, `bun test` green.
- **Phase 2 — Chat core**: full transcript (9 kinds), streaming + typewriter, composer (slash popup, mentions, history/stash), docked approval/question, pickers (model/provider/voice), session lifecycle, widget-inline rendering. Gate: daily-drivable for chat.
- **Phase 3 — Pages engine + manifest**: generic Table/Log/Markdown/Widget/List page renderers; the 11 data panes on the engine; custom-pages reconciliation (tui.layout compat); settings engine. Gate: all data panes + custom pages live-reload work.
- **Phase 4 — Bespoke panes**: Phone hub + global overlay, Canvas/Widgets/Home dashboard, Computer, Browser, Voice, full Settings, SetupWizard, LockGate, DiffReview (real now), Replay, MemoryGraph. Gate: Appendix A has no ❌ left.
- **Phase 5 — Command & delight layer**: Ctrl+K, leader + which-key, remappable keybinds, session tree nav, transcript export, toasts/notifications/sounds, themes, mouse polish, widget dock.
- **Phase 6 — Ship**: parity checklist walk (Appendix A) with screenshots per pane; docs pass (README, cli/README, docs/); packaging (`bun build --compile` per platform; wire into AppImage/Inno/bootstrap; `jarvis tui` → v2 binary, `jarvis tui --legacy` → old one); `/code-review` + fix ALL findings; push dev → test on dev → promote qa → PR to main.

## 6. Testing strategy

- TS: `bun test` + MockDaemon harness port; per-widget unit tests (command table, widget DSL nodes incl. interactive/anim, ControlClient bus, palette key routing — the exact Pilot scenarios that exposed the `/` bug become regression tests).
- Daemon: ctest additions for every new verb (diff.*, schedule.run_now, manifest, command.invoke kinds).
- Legacy python tests stay green until legacy retirement.
- CI: extend self-hosted runners (Ubuntu VM 104 / Windows VM 106) with a bun toolchain job.

---

## Appendix A — Parity checklist (from the audit gap matrix; the ship gate)

### A.1 Ported today (must not regress in v2)
Screening live transcript · DiffReview rendering + slash cmds (pending Phase 0 verbs) · Trust policies pane · Mode/Autonomy/Permissions knobs · SetupWizard (shared setup_complete flag) · LockGate (fail-open, PIN fallback) · ArcReactor everywhere · phone device pairing QR · extension pairing · connectors basic · custom pages · F2/F3/F5 bindings · ctrl+c quit guard.

### A.2 Partial today (v2 closes every listed gap)
Phone shell 3→6 tabs + reactor header + global call overlay + mute-that-mutes · dialer keypad/quick-dial/PSTN/state-dots · browser live preview (graphics opt-in) + clickable refs · computer brain picker + takeover confirm + rich transcript · canvas cap/order/save/pop/delete · widgets →chat/pin/delete · widget DSL image/svg/button/link/anim/pager-nav · ssh exec console · settings identity/defaults/claude-account/voice-library/API-keys/updates-check-now/connectors-flow · voice continuous+phrases+widget-dock · palette (full rebuild per §1) · HUD strip full telemetry · theme tokens centralized.

### A.3 Missing today (v2 adds)
PSTN extended dialer · phone AGENTS roster+config · INBOX (list/detail/compose/new-chat) · HUD ops grid + activity log · **Red Alert** · phone diagnostics + call history · Twilio/SMS/user-number cards · screening transport + carrier codes (real number) · PSTN allowlist + enroll + war room · nested desktop mirror → graphics-mode mirror (opt-in) + text status · FloatingWidgetLayer → widget dock · StandaloneWidget → dedicated widget route (pop-out N/A documented) · WidgetRenderer anim layer · DrivingOverlay → persistent DRIVING banner + stop key (overlay N/A documented) · TitleBar → terminal title sync (window chrome N/A) · HudFrame corner brackets (border chars) · HudFx ambience (subtle bg shade; heavy fx N/A) · GlowCursor N/A documented · API keys grid · accent/density appearance knobs (theme-equivalent) · auth-lock toggle + **PIN set/clear**.

### A.4 Python-TUI-only features preserved
tui.layout.* custom pages · call_degrading UX · ASCII QR · MockDaemon harness (ported) · popup-only screen pattern (kept as routes/dialogs; every one of the 11 also reachable from nav + palette).

### A.5 Known bugs fixed by contract (regression-tested)
`/` focus root causes A+B · mouse-click palette dead-end · no-Escape-close · single-slot broadcast · schedule.run_now missing verb · diff.* vapor · ComputerPane pump leak · GUI mcpCount hardcode · GUI carrier-forwarding placeholder number · browser hint/behavior mismatch (real reload verb).

## Appendix B — Daemon verb inventory (contract reference, audited 2026-07-04)

Dispatch: chained string-compares in `ControlServer::handleRequest` (ControlServer.cpp:427) + `dispatchMemoryOrSkill`/`dispatchOpsMethod`/`dispatchQueueMethod`/`dispatchConfigMethod`; `DeviceServer::dispatchAuthed` mirrors the config set for phones. (Phase 0 may introduce a registration table, additive.)

**Implemented verb namespaces** (all callable by TUI v2 today):
- `session.*`: create, send, wake, cancel, delete, list, history, search, set_goals, subscribe — **images supported** (GUI `sendMessageWithImages`/`supportsVision` ride session.send)
- `settings.*`: get, set · `model.*`: list · `hooks.*`: list, add, remove, test
- `policy.*`: list, add, update, remove, set_default, test
- `phone.*`: mcp (tool proxy), http (REST proxy), event.subscribe
- `widget.*`: viewing, subscribe (+ phone-only pin/unpin); render/remove/clear are broadcast events, not verbs
- `approval.*`: respond · `mcp.*`: list, add, remove, set_enabled, test, cli_list, cli_set_enabled
- `connectors.*`: list, add · `plugins.*`: catalog, install, set_enabled, remove
- `devices.*`: pair_start, list, revoke · `extension.*`: pair_start · `agent_desktop.*`: info
- `take_over.*`: request, cancel · `auth.*`: request, status, deny, verify_pin (+ phone approve/deny)
- `voice.*`: stt, tts, list_voices, create_clone, delete_clone, set_default, rename_clone, preview_clone
- `file.*`: push, get · `update.*`: check, apply
- `memory.*`: list, search, add, edit, remove, entities.list, entity.get, link, graph
- `skills.*`: list, get, create, invoke, remove, today, pin, list_archived, unarchive
- `agents.*`: list, get, create, remove, dispatch, running, result
- `schedule.*`: create, list, set_enabled, remove — **run_now MISSING (Phase 0 adds; GUI's Run button is broken today too)**
- `ssh.*`: allow_list, allow_add, allow_remove, exec · `audit.*`: list · `queue.*`: add, list, get, cancel, remove, set_priority
- `tui.layout.*`: list, add, edit, remove, reorder (custom pages; reserved builtin ids rejected daemon-side; kinds log|table|markdown|widget|list; agent-side MCP tools in computer-use/computer_use_mcp/tools_tui_ops.py)
- `command.*`: list, create, remove, invoke (**mcp_tool/shell kinds not executed — Phase 0**)
- phone-channel only: `task.queue/list`, `push.register`, `mirror.start/stop` · `ping`
- **`diff.*`: ZERO handlers — Phase 0 implements** (Bridge + TUI both already call them)
- `browser.*` is NOT a daemon namespace — both frontends call the per-session computer-use engine HTTP API directly (`agent_desktop.info` → engine base URL). TUI v2 keeps this pattern.

**Broadcast events** (`{"v":1,"event":name,"data":{...}}`): `session.event` (session-scoped), `session.opened` (global + FCM), `auth.event`, `auth.challenge` (phone), `widget.render`/`widget.remove`/`widget.clear` (via widget.subscribe; tailed from widgets.jsonl), `tui.layout.changed` (global), `phone.event` (global), `file.offer` (phone). TUI v2's ControlClient fans ALL of these out through the multi-subscriber bus (§2c).

**GUI Bridge surface for parity cross-check:** ~110 Q_INVOKABLEs / ~65 signals on `desktop/src/Bridge.h` — Appendix A items map 1:1 onto these; any Bridge invokable with no TUI v2 counterpart at the parity gate is a gate failure.
