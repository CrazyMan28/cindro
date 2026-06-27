# Jarvis — Project Status

Single source of truth for **where this project actually is**. Honest about done vs.
partial vs. not-started. Pair with [`../README.md`](../README.md) (overview + architecture)
and [`../AGENTS.md`](../AGENTS.md) (how to work on it + gotchas).

_Last updated: 2026-06-27._

---

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
