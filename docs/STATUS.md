# Jarvis — Project Status

Single source of truth for **where this project actually is**. Honest about done vs.
partial vs. not-started. Pair with [`../README.md`](../README.md) (overview + architecture)
and [`../AGENTS.md`](../AGENTS.md) (how to work on it + gotchas).

_Last updated: 2026-06-29._

---

## 🆕 Public release + Mistral-as-first-class-brain + a Windows edition (2026-06-29)

- **Repo is PUBLIC** (`github.com/CrazyMan28/jarvis`) after a full secret scrub **+ git-history
  rewrite** (filter-repo purged the Firebase key, tailnet IP, demo phone number, emails, and home
  paths from *every* commit; clean `dev`/`qa`/`main` force-pushed). Tracked secrets are gone; real
  keys stay in `~/.config/jarvis/` + gitignored `*.env`. *(Owner TODO: rotate the Firebase key.)*
- **Mistral is now a first-class brain** for users with **no Codex/Claude CLI**: the daemon
  auto-detects the CLIs (`available_brains`), falls back to the **api/Mistral** brain when neither
  is installed, lists Mistral first, and — the real win — `ApiBrain` gained an **OpenAI-style
  function-calling loop**, so Mistral (and OpenAI/Ollama) **drive computer-use/agents/todo**, not
  just chat. `can_drive` now honors a Mistral key. **ctest 24/24.** See [`MISTRAL_SETUP.md`](MISTRAL_SETUP.md).
- **Windows edition (experimental, second-tier)** — *all* Windows code is isolated in **`windows/`**
  with **zero edits to the Linux build** (the rule: copy a Linux file into `windows/` and edit the
  copy; never touch `core/`/`daemon/`/`desktop/`). The engine backend (`windows/engine/`, Win32
  `SendInput`/`mss`, monkeypatch injection) reuses the unchanged engine; the daemon + the ~60 QML
  pages compile via a self-contained `windows/` CMake build (Qt6 + vcpkg, no LayerShellQt). Ships as
  a **self-contained `Jarvis-Setup.exe`** (Inno Setup) bundling Qt + MSVC runtime + a frozen Python
  engine + a portable Node — **the user needs nothing pre-installed**. A GitHub Actions
  `windows-build.yml` produces the `.exe` on `windows-latest`. See [`WINDOWS.md`](WINDOWS.md).
- **Bare-machine installers** — `packaging/bootstrap-install.sh` installs *every* dependency on a
  fresh Linux box (dnf/apt/pacman/zypper) + venv + node + build + install.
- **In progress:** a first-launch **setup wizard** (name/voice/key) for Linux + Windows, and an
  **auto-updater** that watches `main` (default-on toggle + a manual "Check for updates" button;
  Linux pulls+rebuilds+restarts, Windows pulls the latest release installer).
- **Priority, explicit:** **Linux + Android first, Windows second** (maybe more later).

---

## 🆕 Named voice library: record/upload your own + "set as default" everywhere (2026-06-29)

The single hard-wired `jarvice` clone is now a **managed library of named voices** on every
surface. Record your own voice or upload a clip, name it, and **set one as the default** —
used everywhere Jarvis speaks: desktop TTS / voice mode, the phone app's spoken replies, and
**phone calls** (when it calls you and when it answers). **Nothing removed:** `jarvice` is
seeded as the default "Jarvis" voice; every prior picker/behavior stays.

- **Daemon owns the library** (`~/.config/jarvis/voices/` clips + a `voices.json` manifest):
  new core `VoiceLibrary` (CRUD, slug, seed-from-disk, optional ffmpeg clean/trim;
  `voice_library_test`). Contract A `voice.create_clone` / `delete_clone` / `set_default` /
  `rename_clone` / `preview_clone` on **control + device** surfaces; `voice.list_voices`
  merges the named voices ahead of the stock presets.
- **"Set as default" propagates:** desktop + app key off `tts_voice` (instant); for **calls**
  the daemon rewrites `MISTRAL_TTS_REF_AUDIO_FILE` in `phone.env` and **restarts
  `jarvis-phone.service`** (~1–2 s; vendored server otherwise untouched on the global path).
- **UI in both places:** a "Default Voice" card in **Settings → Voice** on desktop
  (`SettingsPage.qml` + `Bridge` `pw-record`/upload) and the **Jarvis Android app** (v0.12.0,
  `SettingsScreen.kt` + `AudioRecorder`/SAF) — list (default · name · source · Preview / Set
  default / Delete), name, Record/Upload, Auto-clean toggle, Save. **Plus** the vendored
  agent-phone per-agent picker now sees the named voices (`cloneVoices.ts` → `/api/voices`;
  `voiceProfiles.set` accepts `clone:<slug>`; `synthesizeForCall` resolves it to `ref_audio`,
  PSTN included), so a clone can be assigned to a specific agent.
- **Verified:** core ctest **23/23**, phone-server **172/172** (4 new), engine pytest **423**,
  desktop `gui_selftest`, Android `assembleDebug`, and a **live throwaway-daemon round-trip**
  (`scripts/voice_library_smoke.py`: list→create→set-default→preview→delete). See
  [`VOICE.md`](VOICE.md).

---

## 🆕 Incoming VOIP works: device stays online + outbound-call (Twilio trial) caveat (2026-06-29)

- **Device (ext 100) now stays online in the background.** The vendored agent-phone
  foreground service (holds the device WS so the phone can receive in-app/VOIP calls) only
  started when the user opened the Phone *tab* — so the device was offline and never rang.
  Jarvis's `MainActivity.onCreate` now starts it on **every** launch (any tab) + re-enables
  the boot receiver (**v0.11.2**). Verified: ext 100 connected, and a test `call_user` **rang
  the app — the user answered ("Hello?")**.
- **Outbound real-phone calls + the Twilio TRIAL account.** With the device offline,
  `call_user_and_wait` escalates to a real PSTN call from the **toll-free** number, which the
  carrier readily **spam-filters to voicemail** (a 265s call had zero transcripts = voicemail).
  The account is also **Trial** (adds a "press a key" preamble; outbound only to verified
  numbers). So: prefer the **in-app path** (keep the device online); for the PSTN fallback,
  save `+15551234567` in contacts + upgrade Twilio out of trial.
- **`phone.mcp` proxy timeout 35s → 300s** so the blocking `*_and_wait` call tools don't time
  out mid-call ("phone server: timeout").

---

## Calls answer + speak (custom voice), brain can call/text, desktop+Chrome parity (2026-06-29)

Inbound calls to the Twilio number now reach Jarvis and **talk back in the user's own
cloned voice**; the brain can call/text; and the desktop/Chrome phone UIs gained the
missing call features. All shipped today.

**Call path (the number answers + speaks):**
- **Instant hang-up** → caller wasn't allow-listed (the handler rejects non-allowlisted
  callers when screening is off). Fixed by allow-listing the user's number.
- **Silent call** → Mistral `/audio/speech` now rejects a `speed` field (HTTP 422), so
  every TTS failed mid-call. Removed `speed` from `phone/server/src/mistral/tts.ts`.
- **Custom cloned voice** → calls send the user's reference clip as `ref_audio` (zero-shot
  clone) via `MISTRAL_TTS_REF_AUDIO_FILE`, instead of the stock voice.
- **Greets by name** → the adapter says "Jarvis here", not "Codex here" (`AGENT_PHONE_NAME`).
- `:8801` now runs as a managed **`jarvis-phone.service`** (journald + auto-restart).

**Brain can call/text** — the brain is isolated (only sees computer-use), so the phone
tools are now registered ON the computer-use engine (`computer_use_mcp/tools_phone.py`,
proxied via `phone.mcp`): 26 explicit (`call_user`, `twilio_call_and_wait`, `device_sms`, …)
plus a generic `phone_tool`. codex's own CLI MCP servers stay off-by-default.

**Desktop + Chrome parity** (from a 133-feature audit, verified by an adversarial workflow
that caught + fixed 13 param/type bugs): desktop **call overlay** (accept/reject/mute/end +
live transcript), inbox response-buttons + reply bar, live diagnostics; Chrome call/screening
UI (v0.5.3); desktop dialer 400s fixed. (The desktop binary had been **stale** — the 6-tab
hub is the current build.)

**Android v0.11.1** — clear **Verizon** call-forwarding instructions (`*71`/`*72`/`*73`) in
Call screening. **`scripts/phone_smoke_test.py`** covers the call-path invariants (ALL PASS).

---

## Android = the original phone app verbatim + Jarvis answers inbound (2026-06-29)

- **Verbatim Android port (Jarvis v0.11.0).** The **entire** original agent-phone Android app
  — all 60 files / ~11,882 lines, package `com.agentphone.*` — is copied **byte-for-byte** into
  the one Jarvis APK; nothing reimplemented or removed. The **Phone tab launches the real
  `com.agentphone.MainActivity`**, so every original screen/setting/button/flow is present
  (Calls · Inbox · Agents · HUD · Settings, setup wizard, agent config, call screening, SMS
  agent, diagnostics, history, enroll, relay puck, call activities/services, on-device sherpa
  TTS). The earlier reimplemented phone UI was deleted. Build green (`assembleDebug`).
- **Jarvis answers when you call OR text.** Ext **101** is the inbound **and** SMS agent; the
  phone server spawns Jarvis's brain adapter **headlessly** on inbound and bridges voice (call)
  or a text reply (SMS). SMS agent enabled → 101; replies go out free via the **device SIM**
  (Twilio toll-free SMS is A2P-gated). Jarvis can **call/text back mid-conversation**.
- **Jarvis is now THE one for the number.** The app default server URL is repointed `:8799` →
  **`:8801`** (Jarvis), and the Tailscale funnel `/twilio` is repointed to `:8801` so inbound
  calls/texts hit Jarvis (ext 101), not the original. The **original `:8799` is left running,
  untouched** (it just no longer receives the Twilio webhook).
- **Tools + skill + docs.** All **~56** phone tools reach the brain (`seedPhoneMcp`). A builtin
  **`/phone` skill** (`seedPhoneSkill`) is the playbook; `internal_docs` bumped to v3 with the
  inbound-wake behavior.

See [`PHONE.md`](PHONE.md).

---

## Full phone UI parity on all 3 surfaces (2026-06-28)

The entire **agent-phone app UI** is now embedded in Jarvis — no new app. A full-screen
**Phone section** (Calls · Inbox · Agents · HUD · Settings) ships on all three surfaces:
**desktop QML**, **Android Compose (v0.10.6+)**, and **Chrome MV3**. Android hides
Jarvis's main bottom nav while inside Phone (full-screen), restoring it on back.

Feature coverage:
- **Calls** — real dialpad (12-key + `*`/`#`) with extension-chip shortcuts, live call
  state machine, history.
- **Inbox** — in-app message threads; **New Chat**: multi-agent picker + optional first
  message + Start (text) or Call button.
- **Agents** — per-agent voice picker + emotion sliders + TTS preview, speaking-rate, LLM
  model, thinking toggle; enroll/unenroll.
- **HUD** — live call HUD (transcription, agent state, mute/hold), diagnostics, Bluetooth
  relay puck.
- **Settings** — call screening + carrier forwarding, SMS agent assignment, setup wizard,
  diagnostics.

Infrastructure shipped alongside the UI:
- **`phone.http`** — new Contract A proxy (`{method, path, body?}` → `{status, data}`)
  forwarding the phone server's REST API to every surface with the admin bearer kept in the
  daemon (`/api/extensions/<ext>/voice`, `/model`, `/api/screening`, `/api/sms-agent`,
  `/api/voices`, `/api/calls`).
- **Jarvis = extension 101** on the phone server. Codex moved to 102; 103–107 are Copilot,
  Echo, Hermes, Claude, Mistral Screener.
- The **original agent-phone repo is untouched** and still runs as its own process. The
  vendored `phone/server` is a byte-identical snapshot (`diff -rq` clean).

See [`PHONE.md`](PHONE.md) and [`AGENT_PHONE_FEATURE_MAP.md`](AGENT_PHONE_FEATURE_MAP.md).

---

## 🆕 Phone + Background jobs + Hooks + Modes (2026-06-28)

A multi-surface capability drop. **Backend done + tested; full UI parity across desktop/
Android/Chrome is in progress.**

- **Native phone subsystem** — the entire agent-phone server (55 MCP tools, ~16k lines)
  vendored verbatim into `phone/server` (its 168 tests pass), runs on `:8801` from a
  Jarvis-managed env (`~/.config/jarvis/phone.env`), wired to the brain via
  `seedPhoneMcp()` and to every UI via the `phone.mcp` Contract A proxy. **Verified live:
  a real Twilio voice call (Mistral TTS) was placed and answered.** Toll-free SMS is gated
  by A2P (the 2019 law) → use the voice path or verify the number. ([PHONE.md](PHONE.md))
- **Background jobs / monitor / sleep-wake** — `bg_start` / `monitor` / `wake_me_in` (+
  status/logs/stop/list/wait) MCP tools; detached jobs auto-**wake** the session on
  completion via the new `session.wake`. Tests pass. ([BACKGROUND_JOBS.md](BACKGROUND_JOBS.md))
- **Hooks** — Claude-Code-style lifecycle hooks (`HookStore`, `~/.config/jarvis/hooks.json`):
  UserPromptSubmit can block/inject; tool/Stop/Notification observational. MCP `hooks_*` +
  Contract A. Tests pass. ([HOOKS.md](HOOKS.md))
- **Modes** — plan / build / co-worker soft profiles + a HUD chip + Settings; wake-notify
  setting. Tests pass. ([MODES.md](MODES.md))
- **Phone UI parity** (Calls/Inbox/dialer/screening/war-room/voice-profiles) added to the
  existing desktop, Android, and Chrome apps (no new app).

---

## 🆕 Live tool cards + reliable subagent wake/timeout (2026-06-28)

Fixes for "tool calls don't show until they finish/time out" and "the subagent never
woke the main agent" — all verified in the real desktop GUI (codex/gpt-5.5):

- **Tool calls render IMMEDIATELY (in-progress).** `codex exec --json` emits
  `item.started` (status `in_progress`) the instant a tool is invoked and only later
  `item.completed` with the output. The parser had **skipped** `item.started`, so a
  long-blocking tool (e.g. `agent_wait`) showed **nothing** until it returned or timed
  out. `CodexParser` now maps `item.started` → an in-progress `tool_call` (spinner +
  "running…"); the matching `item.completed` merges its output and flips the card to
  done. The `finished` heuristic is now status-aware (an `in_progress` item carrying
  `exit_code:null` / empty `aggregated_output` is no longer mistaken for completed).
- **`agent_wait` returns the instant the subagent is done** (running tracked by session
  STATE, not a lingering brain object) — no more waiting for the tool timeout.
- **No more premature tool timeouts.** The injected computer-use MCP servers now set
  `tool_timeout_sec=7200` (codex was cutting a long `agent_wait` short); `agent_wait`'s
  own default is 2h (cap 4h).
- **Subagent wake is robust.** When the model dispatches via the shared real-screen
  engine (no per-session `JARVIS_AGENT_SESSION`), `parent_session_id` arrived empty and
  the child was orphaned (no tree link, no wake). The daemon now falls back to the
  session that is mid-turn (the caller), so the parent link — and the done-wake — always
  holds. Verified: dispatch-without-wait → parent auto-pinged with the result ~40s later.
- **Subagents show a DONE badge** in the pop-out (RUNNING while in flight → DONE on
  summary → ERROR on failure).

---

## 🆕 Subagent UX + skills-via-tool + Home CRUD + nav fix (2026-06-28)

Follow-ups on the agents/skills pass (all promoted dev → qa → main via PR):

- **Subagents actually delegate + report back.** Dispatch is **ad-hoc** (no predefined
  agent needed; the model picks brain/model/system_prompt), every subagent ends with a
  **summary**, and the parent is **auto-woken** with `[SUBAGENT DONE] <summary> · status`
  the moment it finishes. New **`agent_wait(session_id)`** MCP tool BLOCKS for the result
  (`agent_start` → `agent_wait`), plus `agent_result`/`agent_status`/`agent_stop`. Live
  **SUBAGENTS pop-out** lists children (click to open one), and a **"← Main agent"** pill
  returns to the parent.
- **Fixed: clicking a subagent (or any session) jumped to Home.** `Main.qml`
  `onSessionOpened` used a stale `currentIndex = 0` ("Chat" before the Home page existed);
  Home is 0 / Chat is 1 now → fixed to 1.
- **Skills load via a real tool.** Invoking `/skill-name` shows only that as the user
  turn; the model calls the renamed **`skill_load`** tool itself (per the system prompt)
  to load + apply the whole skill — no forced dump. CLI-dir skills (`~/.codex`/`~/.claude`)
  are get/invoke/removable (not just listed); `.system` internals hidden.
- **`internal_docs` skill** seeded on daemon start — a capability catalog the model
  loads (`skill_load("internal_docs")`) when asked what it can do / when unsure.
- **Full desktop-Home CRUD for the model:** `home_list` / `home_pin` / `home_unpin` /
  `home_move` / **`home_clear`**.
- **Subagents are isolated** — a child session gets ONLY its agent prompt + the task
  (no main-agent memory prefetch, no co-work preamble, no memory write-back).
- **Fixed the "random bright text" glitch** — dropped the always-on per-bubble
  MultiEffect brightness glow (it intermittently flooded a bubble bright cyan + cost a
  GPU layer per message); the edge bar is a solid color now.
- **Animated session switch** — the chat transcript fades + slides in when you open a
  subagent (or jump back), and the auto-wake now logs (`jarvisd` journal) for diagnosis.
- **TTS strict FIFO**, plan strikethrough, 200 random-cadence thinking phrases, Chrome
  extension widgets+agents+`/` palette — all in. Branch flow: `dev → qa → main`
  (main protected, PR-only).

## 🆕 "/" command palette + custom agents (subagents) + polish (2026-06-27)

A cross-surface pass — desktop, phone, AND the Chrome extension.

- **"/" command palette** — type `/` in the chat composer → an animated, scrollable,
  filterable menu of **Commands + Agents + Skills** (Claude-Code style). Up/Down +
  Enter/Tab/Esc; picking runs a command or fills the input. On **desktop**
  (`SlashPalette.qml`), **phone** (`ui/chat/SlashPalette.kt`), and the **extension**
  side panel (dropdown + quick-flow chips). The Ctrl+K page jumper is unchanged.
- **Custom agents / subagents (NEW)** — define an agent (name · what it does · when
  to call it · brain/model/profile · system prompt) stored as `AGENT.md`
  (`core/AgentStore`, mirrored to `~/.claude/agents`). Dispatch a task → it runs as a
  **child session** (`parent_session_id` added to sessions; SubAgentTree now real)
  and reports back. Contract A `agents.list/get/create/remove/dispatch/running`
  (mirrored to the phone, biometric tier); model-driven MCP tools `agent_create /
  agent_list / agent_start / agent_status / agent_stop / …`. New **Agents** page on
  desktop + screen on phone. See [`AGENTS_AND_COMMANDS.md`](AGENTS_AND_COMMANDS.md).
- **Right-side panel unified (desktop)** — the model's **PLAN** card now sits ON TOP
  of the live agent-desktop view in one panel, and it opens **only** when a TODO is
  created or an agent desktop is actually in use (no longer pops on the first message).
- **Plan strikethrough** — done TODO items render with a line through them (new
  `strike` text prop in both widget renderers; `tools_todo` sets it on done items).
- **TTS no longer talks over itself** — both voice mode AND the chat "Speak replies"
  path now share ONE strict FIFO queue (single player; requests serialized one at a
  time), so message 1 finishes before message 2 starts. Desktop (`Bridge` TTS) +
  phone (`TtsPlayer` rewritten from new-player-per-clip to a shared queue).
- **Skill creation/visibility fixed (2-part)** — the model is steered to use the
  `create_skill` MCP tool (not its CLI's own skill files), and the Skills list now
  surfaces skills found in `~/.codex/skills` + `~/.claude/skills` (`SkillStore::
  listAll`, skipping `.system` internals). Crucially, **`skills.get`/`invoke`/`remove`
  now resolve those CLI skills too** (the first pass only made them *visible* — View/
  Run returned `no_skill`); `remove` also clears the mirror copies so a deleted skill
  can't resurface. CLI scanning/mirroring is gated to the default root so unit tests
  stay isolated. Live-verified: list → get → invoke on a CLI-only skill all succeed.
- **Chrome extension caught up** — renders the generative widget DSL + the PLAN
  checklist (control-WS `widget.subscribe` broadcast), dispatches/sees agents, the
  "/" palette + quick chips, and a UI/flow polish. (Deep config — MCP/plugins/
  schedules/voice management — stays on desktop/phone by design.)
- **200 thinking phrases** that cycle at a **random** cadence (not a fixed beat) on
  all four surfaces. Android **0.10.0** (vc32).
- Verified: **19/19 ctest** (incl. new `agent_store_test`), **65/65 engine pytest**
  (incl. todo-strike), QML `--selftest` clean, Android `assembleDebug`.

---

## 🆕 Battery idle-teardown + unlock hardening + phone orb (2026-06-28)

- **Battery: idle agent desktops are now torn down — safely.** The blocker was that
  a brain bakes its computer-use engine address+token at spawn, so a torn-down desktop
  used to come back unreachable. Fixed by **reserving each session's (port, bearer)**
  (`AgentDesktop`): a re-provision is byte-identical. A 2-min sweep (`ControlServer::
  sweepIdleDesktops`) tears an AUTO desktop down when its session is **not viewed**
  (no chat/Computer-page lease) **and** hasn't run a turn for **8 min** **and** isn't
  busy; the next turn lazily re-provisions it. The chat + Computer pages hold a viewer
  lease so watching keeps it alive. `releaseSession()` drops the reservation on delete.
- **Unlock hardening (#24).** The phone-unlock root cause still needs a live repro, but
  the LockGate now polls `auth.status` every **1 s** and **re-requests on reconnect**,
  so a missed broadcast clears within a second — on top of the PIN that already lets you
  unlock without waiting on the phone.
- **Phone:** the Home header now shows the spinning **arc-reactor orb** + a fade/slide-in
  entrance (shared component with the chat empty-state). Android 0.9.2.

## 🆕 Home-screen widget: DYNAMIC pin size (2026-06-28)

- **The pin size now adapts to the widget's content.** Android has no per-pin size
  API — `requestPinAppWidget` always uses the chosen *provider's* default cell. So we
  ship **four size-tier providers** (compact 3×2 · default 3×3 · tall 4×5 · xtall 4×7),
  all sharing the same binding/render logic, and `WidgetPinHelper` measures the
  content's natural height and pins via the tier that fits — a big widget (e.g. Thread
  Command Center) pins **tall**, a stat card pins **compact**. Still drag-resizable.
  (0.9.1)

## 🆕 Home-screen widget: full-width readable render (2026-06-28)

- **Tall widgets no longer render as a tiny, side-margined blob.** The bitmap
  renderer was *uniformly* shrinking content to fit a fixed cell, so a tall widget
  (e.g. a process table) became a microscopic centered dot. It now renders at
  **natural, readable size using the FULL width**, and clips overflow with a **soft
  bottom fade** ("more — tap to open") instead of shrinking everything. Default pin
  bumped to a roomier **3×3**. (0.9.0)
- *Android limit, stated plainly:* the OS gives no per-widget pin size — every pin
  uses the provider's default cell (`requestPinAppWidget` shows "3×3"); an app can
  only *request* a resize afterward (best-effort, launcher-dependent). The renderer
  now looks right at whatever size the launcher gives, and drag-resize fills cleanly.

## 🆕 Home-screen widget: pager render + size-to-content (2026-06-27)

- **Pager widgets render on the Android home screen.** The home-widget bitmap
  renderer (`WidgetBitmapRenderer`, separate from the in-app Compose renderer) didn't
  know the `pager` node, so a pinned quiz showed only its intro in a big empty tile.
  It now draws the pager's current page (the first question) — the tile shows real
  content. Plus `naturalHeightPx()` measures the content so the widget **requests a
  cell height that fits** (best-effort launcher resize) instead of a fixed 3×2. (0.8.8)

## 🆕 Image-send fix + home editing + phone empty-state (2026-06-27)

- **Phone/desktop images now reach the model.** The `ApiBrain` (Mistral / direct
  OpenAI·Anthropic) had `Q_UNUSED(images)` — it silently DROPPED every attachment.
  Now it builds a vision content array (text + base64 image parts) in the provider's
  format (OpenAI `image_url` / Anthropic `image` source). Codex (`--image`) and Claude
  (Read-tool) already worked; this was the gap.
- **Home dashboard editing.** Hover a pinned widget → **▲ / ▼ move + ✕ unpin**; the
  order persists (`home_order.json`) and the model can reorder via the new
  `home_move(id, position)` tool. Add/remove via `home_pin`/`home_unpin` as before.
- **Phone fresh-chat empty state** — the blank "bland" new-chat screen now shows an
  **animated arc-reactor orb** (counter-rotating rings + breathing core) + "How can I
  help?". Android 0.8.7.
- Battery teardown of unused nested desktops (#20) is **not** auto-done: the active
  drains (live widgets, video mirror) are already viewer-gated, and tearing the desktop
  down breaks the agent's computer link (the brain's MCP engine address is static) —
  it needs a lazy-provision-at-stable-port redesign, tracked separately.

## 🆕 Live agent view + quizzes + plan panel + unlock PIN (2026-06-27)

- **Live agent-desktop view, end-to-end.** The in-chat peek now mirrors ANY chat's
  nested desktop (not just explicit co-work): the Bridge queries `agent_desktop.info`
  on session change and uses the **per-session engine bearer** for the video poll
  (the global bearer was 401ing — that was the "stuck on WAITING" bug). "⛶ Full"
  → Computer page works (same gating fix + it starts the mirror on arrival).
  Synchronous frame decode kills the flicker. The peek is **drag-resizable**.
  The **phone** mirrors any session too (Computer tab auto-selects the chat).
- **Multi-page animated widgets** — new `pager` DSL node + quiz buttons
  (`{correct:true,next:true}` → ✓/✗ flash → next page), in BOTH renderers. No model
  round-trip per tap.
- **PLAN side panel** — the model's todo (`todo_write` + granular `todo_add/edit/
  done/del`) pops out as an animated card top-right of the chat instead of cluttering
  the transcript; collapses to a 📋 pill.
- **Desktop unlock PIN** — a reliable local fallback (Settings → Security → Unlock
  PIN) for when the phone can't approve. Salted SHA-256 in config (never plaintext);
  `auth.verify_pin` approves the gate. The LockGate shows a PIN field with a shake on
  a wrong PIN. 6 new core test assertions.
- **`desktop_reset`** tool (model clears its own agent desktop); **Computer tab**
  removed from the rail; **ask_user duplicate-question** bug fixed.

---

## 🆕 Desktop redesign + permission system + model TODO (2026-06-27)

The desktop app got the same kind of pass the phone did, plus two new cross-platform
features the user asked for:

- **Desktop redesign** — new **Home dashboard** landing (greeting, active-agent card
  with the spinning ArcReactor, quick actions, recent sessions, live-widget preview),
  NavRail regrouped under WORKSPACE/MIND/SYSTEM headers, and the **Browser** tab removed
  from the rail (the agent's browser surfaces through the in-chat **agent peek** instead).
- **In-chat agent peek** — an animated right-side panel that slides open while an agent
  is active so you can watch its nested desktop / Chrome tab without leaving the chat
  (`AgentPeek.qml`, mirror-on-visible). Plus an in-transcript **chat search** (⌕).
- **Permission system (NEW)** — tools are auto-ranked **HIGH / MEDIUM / LOW** by
  capability, and a `permission_level` setting (`high` *Cautious* · `medium` *Balanced*
  (default) · `low` *Autonomous*) drives a **soft ask-before-risky policy** injected into
  the co-work preamble: the model calls `ask_user` before acting at/above your chosen
  line. It is a *policy*, not the sandbox — capability tiers stay enforced. Configurable
  in **Settings → Permissions** on **both** desktop and phone (biometric-gated patch).
- **Model TODO (NEW)** — the agent can publish a live plan with `todo_write` /
  `todo_read` / `todo_clear` (computer-use engine). It persists per session and renders a
  **checklist card** (✓ / ◐ / ○ with a `done/total` count) inline in chat + on the Canvas,
  on desktop **and** phone, via the existing widget bus (stable id → updates in place).
  The preamble tells the model to use it for any 3+-step task. 6 new engine tests.
- Also fixed a **stale `test_jarvis_seat_routing` test** (it predated the atomic-click
  change and asserted the old press/release contract). Engine suite back to green (62).
- **Home dashboard — texture, motion + REAL telemetry.** The built Home read flatter/
  emptier than the mockup (the agent-peek vanished when idle, Live widgets was a bare
  bar). Rebuilt: the hero card now has an **always-on textured agent peek** (diagonal
  scanlines + a drifting cyan glow + the spinning ArcReactor), the right column is a
  **live mini-dashboard wired to REAL system stats** — CPU / RAM (animated bar charts) +
  GPU (nvidia-smi: name, util, VRAM) / NET — and there's motion throughout (entrance
  fade-up, hover-lift cards, pulsing status dots). The HUD strip's CPU/RAM/NET are now
  **real** too (Bridge polls `/proc/stat` + `/proc/meminfo` + `/proc/net/dev` every 1.5 s;
  was a simulated random-walk). The same textured peek is reused in the chat agent-peek.
- **Palette refresh to match the mockup** — the desktop render had drifted darker/muddier
  than the approved HTML (`jarvis-desktop-redesign.html`): heavily-translucent surfaces
  over a dark gradient + cyan-tinted borders everywhere. `Theme.qml` now uses **solid,
  lighter blue-grey cards** (`#111A25` / `#15212F`), **neutral hairlines** (`#1E2C3B` /
  `#26384A`), and the mockup's **softer cyan** (`#3DD6FF`, + `accent2 #5B8CFF`); energy
  accents softened (success `#39E6A0`, danger `#FF6B6B`, violet `#B28BFF`). Reads crisp +
  premium across every page (Home/Chat/Settings/Voice/Canvas verified). ArcReactor kept.

---

## 🆕 Premium phone UI + widget/lifecycle fixes + Mistral + scroll (2026-06-27)

- **Premium phone redesign** (v0.8.x): new **Home dashboard** (greeting, quick-action
  tiles, recent-session cards with avatars/status, a live-widget preview), nav is now
  **Home · Chat · Canvas · Computer · Settings**, gradient chat bubbles, clean sans type
  system + palette (built from an approved HTML mockup).
- **"Deleted widget keeps coming back" — FIXED.** The desktop "✕" wrote a bus remove
  marker but never reached the engine, so the supervisor re-rendered it. The supervisor
  now honors bus `remove`/`clear` markers (offset-tracked, ts-gated) and stops the job.
  The phone now also handles remove/clear: the home-screen tile clears to its placeholder
  and the Canvas gallery + catalog drop it (one-time stale-cache wipe on update).
- **Real home-screen widget** now scales-to-fit (no cut-off), drops the svg "open app"
  fallback, and the "Couldn't add widget" preview error is fixed (invalid preview drawable).
- **Mistral API** key field added to desktop Settings (backend already supported
  mistral-large/small-latest via the api brain).
- **Fast mouse-wheel scrolling** on the desktop Canvas + Chat lists (the default Flickable
  step was a sliver).

---

## 🆕 Widgets battery + real phone widget + lag + flow (2026-06-26)

A four-part pass (branch `feat/widgets-lifecycle-phone-widget`):

- **Live-widget battery fix** — live jobs were detached loops that ran forever
  (delete removed only the render). Now ONE viewer-gated supervisor: a job runs only
  while a desktop/phone viewer or a home-screen pin is watching it (daemon-owned
  lease registry, 45 s TTL), idles otherwise, resumes on reopen. Deleting a
  canvas/widget stops its job. 21 engine tests + new `WidgetLeaseRegistry` ctest.
- **Real Android home-screen widget** — 1-click "📌 Pin" turns any canvas into a
  live AppWidget (DSL → bitmap, push-driven, aggressive battery: refreshes only
  while unlocked, 60 s floor). `android/.../widget/*`, versionName 0.8.0.
- **Chat lag fixed** — capped the text fed to QML `Text` layout (it measures the
  whole string even when elided), lowered `maximumLineCount`, gated the infinite
  approval/question blur on window focus, `cacheBuffer` 800/600→300, diff Repeater
  60→30; Android `ChatItem` `@Immutable`.
- **Flow** — desktop NavRail regrouped into 4 sections + Ctrl+K quick-switcher +
  lazy pages; phone gets a dedicated **Canvas** tab/screen (pin-to-home), nav
  restructure, and fade-through/slide motion.

---

## 🆕 Canvas & Widgets overhaul (2026-06-25)

A big pass on the generative-UI system — see [`WIDGETS_CANVAS.md`](WIDGETS_CANVAS.md).

**Done & verified (live):**
- **Renderer fixed** — nested grids/lists/containers were collapsing (QVariant-list
  vs `Array.isArray`); `asArray()` coercion + loader sizing now render a full
  multi-section dashboard correctly.
- **Expanded DSL** — container styling (bg/pad/radius/border/size), per-child
  `grow`/`align`/`w`/`h`, rich text, `spacer`, `divider`, button styling, and
  `anim` (pulse/fade/spin/float/blink).
- **Canvas vs Widget split** — Canvas tab (ad-hoc, deletable, ★-saveable) +
  a new **Widgets** tab (reusable library). MCP CRUD: `canvas_*`, `widget_*`.
- **Chat gating** — canvases only enter chat/voice on `target` (default canvas);
  scoped to the session and **replayed on reopen** (was lost before).
- **Live canvases** — `widget_live(id,command,spec,interval)` re-renders from ANY
  command's output on a cadence; verified live (a CPU/GPU widget updating in a real
  Jarvis chat).
- **Settings QR pairing** fixed (ms-vs-seconds → int overflow → instant "Expired").
- **Phone widget renderer (v0.6.0)** — the Android app now draws canvases/widgets:
  the daemon (DeviceServer) tails the bus and forwards `widget.render/remove/clear`
  to subscribed phones; a Compose `WidgetRenderer` interprets the full DSL (incl.
  SVG via WebView, canvas ops, animation). Daemon→device forward verified
  end-to-end (paired device received the frame); on-device visual confirmed once the
  phone pulls v0.6.0. APK pushed to the phone store.

- **KDE computer-use clicks (~95% fail) — FIXED.** Root cause (found via
  WAYLAND_DEBUG): `JarvisSeat::refocusAt` passed the surface-LOCAL offset as
  `notifyPointerEnter`'s 3rd arg, but that arg is the surface's GLOBAL ORIGIN
  (it builds `translate(-surfacePosition)`), so clients got `pos-local` =
  out-of-bounds → every click dropped. Fixed to pass `pos-local` + an atomic
  `pointerClick`; `input.py` now routes real-screen clicks through it. Verified
  live (System Settings navigates reliably via the jarvis seat, not the user's
  mouse). Driving `GlowCursor` shrunk (84→56) so it doesn't block the model's view.
  (KWin-fork change lives in `kwin-jarvis-fork`; deploy via atomic-rename install
  + relogin — see the kwin-fork memory.)

**Open / not done:**
- _(none from this overhaul — all shipped.)_

---

## What even is this?

**Jarvis** is one AI co-worker you can drive from your **Linux desktop**, your **Android
phone**, and a **Chrome extension** — all talking to one local daemon. It chats, **drives
your computer** (its own nested desktop or your real screen, with a glowing cursor +
consent), **talks** (hands-free voice), pops up **custom widgets**, runs **scheduled** tasks,
keeps **memories/skills**, and can pull in **MCP tools** (incl. Google connectors). "Coder
when needed, co-worker otherwise."

**Shape:** `core/` (C++/Qt6 shared lib) · `daemon/` (jarvisd: control WS :8795 + device WS
:8796) · `desktop/` (jarvis-sidebar, QML) · `computer-use/` (Python FastMCP engine :8794) ·
`android/` (Kotlin/Compose) · `extension/` (Chrome MV3). Brains: **codex** / **claude** CLIs +
a direct **api** loop, all normalized to one event stream (Contract A).

---

## ✅ Done & verified

Verified = unit tests pass, live WS check, and/or exercised on the running daemon.

- **Core/daemon:** sessions, the 3 brains, Contract A on all channels, scheduler (cron +
  natural language), memories, skills, SSH allow-list, prompt-injection gating, plugin
  registry. **15/15 ctest, 32/32 engine pytest.**
- **Strict MCP isolation** per brain (codex `--ignore-user-config`, claude
  `--strict-mcp-config`) + opt-in CLI-MCP toggles.
- **Desktop chat:** streaming/typewriter, brain+model picker, stop button, auto-titled
  sessions, in-conversation thinking orb + funny phrases.
- **Session management (isolation) — verified with logs:** desktop / phone / Chrome / voice
  sessions are **separate**. A foreign session opening only raises the window (never hijacks the
  chat); opening an old session **resumes** it (re-spawns the brain) instead of "inactive session";
  `+ New` clears + drops the session; sessions are a flat, openable, deletable list.
  - **Session manager — per-client `session.subscribe` scoping (the real fix for "a Chrome chat
    shows in the desktop"):** the daemon used to **broadcast every session's `session.event` to
    every connected control client**, leaving each client to filter client-side — so a Chrome
    co-work transcript reached the desktop and could linger (the desktop is a singleton; "opening"
    Jarvis just toggles the same process, so stale page content survived). Now a client declares the
    session ids it is viewing via **`session.subscribe {session_ids}`** and the daemon fans
    `session.event` **only** for those ids to it (`m_scopedClients` + `m_subscriptions` in
    `ControlServer`). The desktop subscribes to its current chat + coworker + voice sessions on
    connect and on every change (`Bridge::syncSubscriptions`); a fresh, sessionless chat subscribes
    to **nothing**, so a foreign session can never arrive. Back-compat: clients that never subscribe
    keep the legacy broadcast, and the **phone uses a separate `DeviceServer` channel** (unaffected);
    an older daemon answers `unknown_method`, which the desktop swallows and falls back to the
    existing client-side filter. Proven end-to-end by **`scripts/session_subscribe_ws.py`**: a
    bystander scoped to `[]` receives **zero** `session.event` frames while another session emits
    five to its subscriber. The COMPUTER page now also clears its transcript when its coworker
    session ends, mirroring the chat reconciler.
  - **Transcript↔session reconciler (the real root cause of "+ New won't clear" / "mirrors Chrome"
    / "shows the old chat"):** the chat transcript (`chatModel`) and the current session
    (`m_sessionId`) had no single binding — every transition (+ New, open, delete, create, coworker,
    voice) was responsible for clearing the transcript itself, and several didn't (`deleteSession`,
    the coworker create, and an async `session.history` race all left old content under a different/
    empty session — the "chat full of content + 'Type to start a session…'" screenshot). Fixed by
    making the transcript a **strict function of the session**: `JarvisPanel` tracks
    `chatSessionId`, and a single `onSessionIdChanged` reconciler wipes the transcript whenever
    `bridge.sessionId` changes to anything else. A `pendingNewSession` flag lets the reconciler
    *adopt* (not wipe) when the user's own first message is mid-create, so "it removes what I said"
    can't recur. Belt-and-suspenders guards remain: `Bridge::handleResponse` drops a stale
    `session.history` reply (`!= m_sessionId`), and the live/history handlers re-check
    `=== bridge.sessionId`. Covered by a new **`session_reconcile` QtQuick.Test** (8 cases: + New,
    open-other, delete-current, stale-history, foreign-Chrome-event, first-message-survives-create).
    **17/17 ctest** (incl. `gui_selftest` + `session_reconcile`).
- **Memory quality + CRUD (the "new chat remembered my Chrome chat" fix):** a co-work session had
  dumped whole webpages into long-term memory, which the daemon injects into EVERY turn
  (`prefetchMemoryBlock`) — so a fresh chat "remembered" them. Now a memory is a concise **fact**:
  `handleMemoryAdd`/`handleMemoryEdit` reject writes > 2000 chars (`memory_too_large`), and
  `syncTurnMemory` only auto-saves a "remember …" cue at the **start** of a short message, capped to
  one ≤280-char line (was an `indexOf`-anywhere grab of the whole tail). The 4 junk dumps were
  deleted; the real facts kept. Full CRUD exists end-to-end: `memory.add` / `memory.edit` (new) /
  `memory.remove` / `memory.list` / `memory.search`, all exposed to the model as `jarvis_memory_*`
  MCP tools (so the model can see, add, edit, delete its own memory). Verified live: add→edit→list→remove.
- **Skills CRUD for the model:** `jarvis_skill_list` / `jarvis_skill_get` / `jarvis_skill_create`
  (create-or-overwrite = edit) / `jarvis_skill_remove` / `jarvis_skill_invoke` MCP tools over the
  existing `skills.*` Contract-A surface — the model can author, edit, and delete its own skills.
- **Phone: images render + robust photo attach (v0.5.5):** the chat now renders base64 image
  results (screenshots/photos the model sends) as actual pictures via Coil — `ChatViewModel`
  extracts image blobs from tool results and `ToolCallBubble` shows them (no more walls of base64).
  Photo **attach** is hardened with `ImageDecoder` (software allocator) + a `BitmapFactory` fallback,
  fixing "Couldn't attach that photo" on HEIC camera shots. Backend already forwards `images` to the
  brain (`Brain::send(text, images)` via `decodeSendImages`), so the model can see sent photos.
- **Send-any-file to the user:** `jarvis_send_file` MCP tool wraps `file.push` (b64 OR on-disk path
  + display name) so the model can send the user ANY file type (photo, PDF, log, zip) to the phone
  as a `file.offer`.
- **Voice orb animation:** smooth "breathing" while thinking/speaking + a soft mic-level swell
  while listening (replaced the abrupt size-jump).
- **Voice mode:** hands-free (no hold-to-talk) capture via **pw-record** (the path that
  actually works on this PipeWire box), RMS VAD calibrated to the mic noise floor (~0.5s
  end-of-turn), brain/model/**speaker** pickers, live mic-level orb. Mistral Voxtral
  **STT+TTS round-trip verified.**
- **Generative renderer:** `render_widget` tool + a brain primer that tells the model to call
  it; widgets render as **draggable floating cards** in chat & voice + a persistent Canvas tab.
- **2FA + fingerprint cross-device unlock:** desktop/Chrome lock → challenge pushed over the
  device WS → phone notification → BiometricPrompt → approve → unlock. **Fail-open anti-brick**
  when no phone is reachable. Desktop lock defaults on.
- **Notifications without Firebase:** Android foreground `JarvisConnectionService` holds the
  device WS open and posts local notifications (new session, file offer, **auth challenge**).
- **Android app:** chat (typewriter + visible tools), **photo send** (crash-proofed),
  **Speak-replies** toggle (default off), sessions, MCP CLI toggles, biometric app-gate. Built
  + pushed to the phone store (current **vc9 / 0.5.4**).
- **Mic routing (system fix):** the working built-in DMIC array wasn't exposed by PipeWire
  (its card profile was "off"; the default source was a dead analog jack). Added a PipeWire
  source for it + set it default + sane gain. Capture verified.
- **KDE plasmoid** to toggle the sidebar.
- **Live video to the phone (MJPEG):** the daemon mirrors a session's screen as
  `mirror.frame` binary frames over the device WS; the Android Computer screen decodes
  + displays them. (Works today; WebRTC below is a smoother upgrade, not a prerequisite.)
- **Plugin marketplace:** `PluginRegistry` + `plugins.catalog`/`plugins.install`, a desktop
  `PluginsPage`, an Android `PluginsScreen`, signed-package format + a seeded sample. Functional
  (UI polish is the only open bit).
- **Model-generated session titles:** an async Mistral call names each session from its first
  message ("…segfault in my C++ code" → "Debugging C++ Pointer Segfault"). Verified.
- **Real Google Docs/Drive MCP:** both route through `@modelcontextprotocol/server-gdrive`.
- **GUI integration test:** `jarvis-sidebar --selftest` loads the whole UI offscreen + verifies
  it renders → the `gui_selftest` ctest (16/16 total).
- **KWin multi-seat fork — DONE & running live:** a forked `kwin 6.7.0`
  (`~/projects/kwin-build/bin/kwin_wayland`, source in `~/projects/kwin-jarvis-fork/`)
  gives the agent its own seat/cursor on the real screen. (Confirmed: it's the active
  compositor.)

---

## ⚠️ Partial / works-but-with-caveats / needs your action

- **Google connectors:** framework + Settings UI (per-service Client ID/secret/refresh-token
  form) + in-app Google-Cloud setup guide are done, and real creds now **enable** the
  connector (= the brain gets it as an MCP server + its tools). **Caveats:** you must supply
  OAuth creds; **Calendar** (`@cocal/google-calendar-mcp`) and **Gmail**
  (`@gongrzhe/server-gmail-autoauth-mcp`) use real npm packages, but **Docs/Drive** point at
  `@google/*` packages that may not exist yet (those won't provide tools until a real package
  is wired). Connectors are desktop/control-only (not exposed on the phone channel).
- **2FA unlock end-to-end:** code-complete + the WS path is wired, but the **full phone↔desktop
  biometric loop hasn't been exercised on the real device** by me. Needs the phone app open
  (the foreground service must be connected) to be a reachable approver.
- **Voice mode tuning:** working, but the VAD/gain are calibrated to **this machine's** DMIC
  noise floor — a different mic/room may need re-tuning. The DMIC PipeWire source uses
  `hw:3,0`, which could change if ALSA card ordering changes on reboot.
- **Session titles:** auto-titled from the **first user message** (truncated). The requested
  **model-generated** title (a short summary) is **not done** — it needs an extra LLM call.

---

## ⛔ Not started / next up

Most of the earlier "next up" list is now **done** (titles, Docs/Drive MCP, DMIC by-name, 2FA
flow verified, GUI test) and KWin was already done. What genuinely remains:

1. **WebRTC live video (Wave C)** — **deferred by user decision** (kept out for now; MJPEG live
   video covers it). A smoother 30fps upgrade: GStreamer `webrtcbin` pipeline + signaling over
   the device WS + an Android **libwebrtc** client + ICE/STUN. Deps verified present
   (GStreamer 1.28 + webrtcbin + VP8), so it's a clean future build — just multi-day.
2. **Plugin marketplace UI polish** — the registry/install/pages all work; this is cosmetic.
3. **Richer renderer widgets** (more DSL node types), and a true **clicking** GUI test (the
   `gui_selftest` covers load/render, not interaction).
4. **2FA on real hardware:** the WS flow is verified (`auth_gate_check.py` OK); only the
   physical phone's fingerprint UI is untested from here.

---

## How to verify quickly

```bash
cmake --build build && ctest --test-dir build           # 15/15
cd computer-use && env -u PYTHONPATH .venv/bin/python -m pytest tests -q   # 32/32
cd android && ./gradlew :app:assembleDebug              # APK
QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 build/desktop/jarvis-sidebar --demo  # QML loads clean
env -u PYTHONPATH uv run --with websockets python scripts/roadmap_live_verify.py         # live daemon checks
env -u PYTHONPATH uv run --with websockets python scripts/voice_roundtrip_test.py        # Mistral STT/TTS
```
