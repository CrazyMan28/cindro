# Cindro — Project Status

Single source of truth for **where this project actually is**. Honest about done vs.
partial vs. not-started. Pair with [`../README.md`](../README.md) (overview + architecture)
and [`../AGENTS.md`](../AGENTS.md) (how to work on it + gotchas).

_Last updated: 2026-07-13._

---

## 🆕 Windows Sandbox agent-desktop tier (v2): validated end-to-end on real hardware for the first time (2026-07-13)

Issue #104 tracked the one thing this repo could never actually test: the Windows Sandbox
isolation tier (`windows.isolation.mode=sandbox`, see `windows/isolation/DESIGN.md`) only ever
*compiled* — the CI runner can't boot nested Hyper-V, so `AgentDesktop::ensure()`'s sandbox path
had never once executed for real. Tonight it did, on a real Windows 11 Pro box, and a
`session.create` with a `coworker` profile now genuinely returns `agent_desktop.up: true` —
confirmed independently three times, with the in-sandbox engine's own `/ready` probe corroborating
a real screen capture (`{"ready":true,"kind":"agent","bytes":8320}`).

Four real bugs surfaced and fixed, each invisible to CI because none of them can manifest without
an actual booting Windows Sandbox VM:

1. **`bootstrap.ps1`'s `Write-Host` deadlocked the entire script.** Windows Sandbox's
   `LogonCommand` runs non-interactively with no attached console to drain output — the very
   first `Write-Host` call blocks forever, so nothing after it (including the file-based logging
   meant to diagnose exactly this) ever ran. Logger is `Add-Content`-only now.
2. **`jarvisd.exe` crashed (access violation, reproducible at an identical `Qt6Core.dll` fault
   offset going back to 2026-07-11) inside the health-check polling loop.** The loop recreated a
   `QNetworkAccessManager`/`QNetworkReply`/`QEventLoop`/`QTimer` set on every one of ~150
   iterations over the cold-boot budget — a known-fragile Qt pattern under sustained real use.
   Replaced with a raw `QTcpSocket`-based HTTP check.
3. **The rendered `.wsb` had an XML prolog + a multi-line doc comment before `<Configuration>`.**
   Windows Sandbox's config reader silently treats that as unparseable and falls back to a bare
   default sandbox with no `LogonCommand` at all — the VM boots and stays alive, but nothing ever
   runs, with no error surfaced anywhere (`jarvisd` runs headless/Session 0, so even a GUI
   parse-error dialog, if one exists, is never seen). This was *the* root cause of the "why does
   even a trivial one-line command never fire" mystery — proven via an isolated A/B test bypassing
   `jarvisd` entirely (no-prolog file: marker written in ~10s; original structure: nothing after
   135s). Fixed by emitting the file from a dedicated docs-end sentinel (not a fragile literal
   `"<Configuration"` search, which a future doc-prose edit could accidentally match) and
   XML-escaping every substituted token.
4. **The fix for bug 2 introduced a new deadlock.** `QThread::msleep()`-based polling blocks the
   whole Qt thread without pumping its event loop — but the in-process reverse tunnel
   (`windows/isolation/relay/ReverseTunnel.cpp`) needs that same thread's event loop running to
   accept the sandbox's incoming rendezvous connection. The kernel-level TCP connect was
   succeeding the entire time; pairing simply never got a chance to dispatch. Rewritten to be
   `QEventLoop`/`QTimer`-driven so the thread keeps pumping, while still avoiding the original
   crash-causing `QNetworkAccessManager` pattern.

A high-effort code review of the resulting diff (8 finder angles + verification) surfaced two
further real bugs, fixed before merge: `closeSandboxHostProcesses()` (added for the fix above)
had no ownership check before taskkilling sandbox processes by image name, and — worse — a race
where a second concurrent `ensure()` call could slip past the single-instance guard while the
first was still mid-boot (`m_desks` isn't populated until both HTTP waiters succeed), so one
session's failure-path cleanup could kill another session's genuinely live, healthy sandbox.
Closed with an in-process `ProvisioningLock` that claims the slot immediately after the guard
passes, not after boot completes. Also removed a diagnostic TCP probe in `bootstrap.ps1` that
could itself steal `ReverseTunnel`'s pairing slot from a real health-check client (the review's
own explanation for why the fix for bug 3, above, sometimes still needed a retry).

Still gated behind `JARVIS_ENABLE_V2=1` (see `resolveMode()` in `windows/shell/AgentDesktop.cpp`)
— proven on one real machine tonight, not yet validated broadly enough to flip the default.
`childsession`/`hyperv` (Phases 2/3) remain unbuilt.

---

## 🆕 Android: Claude/ChatGPT-style redesign — drawer nav + chat-first launch (2026-07-12)

The Android app's navigation was rebuilt from scratch to read as a professional,
first-party chat app (v0.15.0): a Material3 navigation **drawer** replaces the old
fixed 6-tab bottom bar, and the app now **opens straight into an active chat
composer** instead of a Home dashboard — matching how Claude and ChatGPT mobile
actually behave, per user-supplied reference screenshots.

- **One flat, drawer-driven nav graph.** The old two-tier nav (an outer graph +
  an inner bottom-tab `Shell()`) collapsed into one flat `NavHost` in
  `AppNav.kt`. Every former tab (Canvas/Computer/Phone/Settings) AND every
  former "More" hub entry (Skills/Agents/Queue/MCP/Plugins/Memory/Files) is now
  a plain sibling route reached from the sidebar — tapping a drawer item pushes
  that screen over chat; its own back arrow returns to chat.
- **`CHAT_HOME`** (new, blank landing composer) replaces `Routes.HOME` as the
  graph's start destination. Reuses the existing `HomeViewModel` unchanged
  (sessions/latestCanvas/createSession) and `ChatScreen`'s `ChatEmptyState`/
  `InputRow` (both promoted from `private` to shared). Home's old 2×2 quick
  actions became a `SuggestionChip` row; the live-widget card survives,
  collapsed by default.
- **First-message handoff (`PendingFirstMessage`, `ChatModels.kt`).** The blank
  composer has no session id to send against until `session.create` returns —
  it stashes the typed draft/photos keyed by the new session id, and
  `ChatViewModel.init()` consumes+sends it the moment it mounts, going through
  the SAME `send()` path (optimistic bubble, haptics, slash commands) as any
  other message.
- **Chat top bar**: hamburger (opens drawer) replaces the back arrow; a
  `ChatModelChip` shows the session's brain/model (read-only — no daemon RPC
  exists to switch brain/model on a live session; tapping it explains that and
  points at New chat).
- **Caught in code review before this shipped** (8-angle high-effort pass +
  independent feature-parity subagent, both run against the diff): promoting
  Sessions/Canvas/Computer/Phone/Settings out of the old gated `Shell()` into
  top-level routes had silently DROPPED the biometric app-open gate on all
  five (plus a pre-existing gap on Skills/Agents/Queue/MCP/Plugins/Memory/Files
  that had never been gated at all) — fixed with a shared `Gated()` wrapper
  applied to every non-pairing route. Also fixed: the new chat composer's mic
  button fired instantly on press and discarded any already-typed draft/photos
  while creating an unwanted session; `sendFirst()` cleared the draft before
  `session.create` was known to succeed, silently losing the message on
  failure with no error shown; the drawer's destination navigation had dropped
  the old tab-switcher's `popUpTo`/`saveState`/`restoreState`, so hopping
  between drawer screens grew the back stack unboundedly; and four promoted
  screens (Sessions/Canvas/Computer/Settings) had no on-screen way back at all
  (system back only) since they used to rely on being a bottom tab. See
  `AGENTS.md`'s matching entry for the load-bearing details.
- Deliberately **out of scope for this pass** (filed as follow-up, not a
  regression): Voice mode, Browser control, Schedules/Workflows, Memory Graph,
  Activity log, Replay, and Google Connectors still have no dedicated Android
  page — desktop/web already have them, Android didn't before this redesign
  either, and the drawer's IA has room for them later.
- Verified: `./gradlew assembleDebug testDebugUnitTest` clean (portable JDK +
  Android SDK cmdline-tools, no local toolchain was preinstalled on this box),
  an independent feature-parity subagent audit (cold review against
  `git show HEAD:...` for every old screen/callback/gate) found zero gaps. No
  device/emulator was available to smoke-test the live UI — that's still
  outstanding before this should be considered fully verified end-to-end.

---

## 🆕 Bug fix: phone-initiated sessions silently failed on Windows (jarvis#107) (2026-07-12)

Filed during the redesign above as "Windows: session creation from phone hangs on
cross-device unlock" — the desktop showed "check phone to unlock" and the new chat
never opened, though `session.create` rows were confirmed landing in `jarvis.db`.
Root-caused by re-reading the code (no live repro needed): **not** an unlock/2FA bug
at all — `ControlServer::createSession()` treats a failed `AgentDesktop::ensure()` as
FATAL for any explicit coworker+agent session, and the Android app's Home/Voice/new-chat
flows default to exactly that profile (`JarvisRepository.createSession(profile =
"coworker")`, no `target` override). `AgentDesktop::nestedDesktopSupported()` is
`false` by default on Windows (ships as v1 real-screen take-over; the v2 Sandbox tier
needs an explicit `JARVIS_ENABLE_V2` opt-in), so `ensure()` always returns `up=false`
there — meaning **every** phone-initiated session hard-failed server-side on stock
Windows (row committed, then immediately marked `error`) while working fine on Linux,
where `nestedDesktopSupported()` is always `true`. `makeBrain()` already had a
graceful global-`:8794`-engine fallback for exactly this case (`row.profile ==
"coworker"` branches for codex/claude/api, added in the 2026-07-02 bug sweep below) —
`createSession()`'s early fatal return just never gave it the chance to run.
- **Fix:** the fatal-on-`explicitAgent` branch now only fires when
  `nestedDesktopSupported()` is true (a REAL `ensure()` failure on a platform that
  should support isolation); otherwise it degrades like the existing AUTO-computer
  path, letting `makeBrain()`'s fallback inject the global engine.
- **Also fixed:** `HomeScreen.kt`'s `onNewChat`/`onVoice` and `NewChatScreen.kt`'s
  `startVoiceChat()` never passed `viewModel.createSession`'s `onError` callback, so
  ANY `session.create` failure (not just this one) was swallowed with zero user
  feedback — the exact silent-failure pattern already fixed for `sendFirst()` earlier
  in this same redesign (see above). Both now toast on failure.
- **Not verified end-to-end:** this box has no MSVC toolchain (Qt is `msvc2022_64`,
  only MinGW g++ is installed — ABI-incompatible, confirmed by a failed trial build)
  and no JDK, so neither the daemon nor the Android change could be compiled here.
  The diff was reviewed by hand against the existing, already-compiling
  `AgentDesktop::nestedDesktopSupported()` call site (`ControlServer.cpp:2066`) and
  the existing `onError` pattern (`NewChatScreen.kt`'s `sendFirst()`). Needs a real
  Windows build + phone repro to close out jarvis#107 for good.

---

## 🆕 Dynamic model discovery: codex/claude model pickers stop going stale (2026-07-11)

The codex/claude model lists shown in every picker (chat, Settings default
model, `/model` in the terminal) were a hardcoded array in the daemon —
frozen at whatever Orin version last shipped, so a new OpenAI/Anthropic
model release never showed up until an Orin code change caught up. Both CLI
brains now get a real, live catalog merged in on top of the same static
floor, fetched async and cached (never blocking a `model.list` call):

- **codex**: `codex debug models --bundled` (an unofficial debugging
  subcommand — live-verified 0.144.1 output shape, fails open to the static
  list on any mismatch or if the CLI isn't on PATH).
- **claude**: the CLI has no list-models command, but its own OAuth session
  can call the **public, documented** `GET
  https://api.anthropic.com/v1/models` directly — same technique a
  third-party open-source plugin already uses in production against the
  sibling `/api/oauth/usage` endpoint for Claude Code's own `/usage` command.
  Reads the token from the SAME pro/max-account dir `ClaudeBrain` itself is
  spawned with, not an independent guess.
- Caught in review before merge: the first draft's account-resolution picked
  from `CLAUDE_CONFIG_DIR`/`~/.claude`/`~/.claude-secondary` in a fixed
  order instead of the daemon's own account setting (could silently surface
  the wrong account's models), the Settings page's default-model dropdown
  (`settings.get`'s `models_by_brain`) wasn't wired to the live catalog even
  though the chat picker was, and the codex subprocess never drained its
  stderr pipe (a theoretical hang if the unofficial subcommand ever logs
  more than the OS pipe buffer). All three fixed; see AGENTS.md's "Dynamic
  model discovery" entry for the full design.
- Live-verified end-to-end against an isolated test daemon instance (profile
  isolation via `JARVIS_CONFIG_DIR`/`JARVIS_DATA_DIR`, never touching the
  live production daemon): both catalogs merge correctly, `settings.get` and
  `model.list` agree, and the fail-open path (codex hidden from PATH) falls
  back to the static list cleanly with no daemon stall or crash. New
  `core/tests/model_catalog_test.cpp` pins the parse/merge/dedup logic
  against the real response shapes. Windows: local incremental build clean
  (`windows/build-win`); Linux: pending CI on this PR (`ctest --test-dir
  build`) — no `windows/`-only code, the daemon change is shared and applies
  to both editions identically.

---

## 🆕 KWin-fork agent keyboard fixed: per-seat modifiers (2026-07-10)

The reported "agent's mouse works but its keyboard commands go somewhere
else" bug on the multi-seat KWin fork is root-caused and fixed. The `jarvis`
seat never sent `wl_keyboard.modifiers` (clients never derive modifier state
from raw keys), so every client saw `modifiers=0` forever: `ctrl+v` typed a
literal `v`, `shift+a` gave lowercase — agent keyboard *commands* degenerated
into stray text. Fix: `JarvisSeat` now owns its own `xkb_state` (fed only by
agent keys, mirroring stock `keyboard_input.cpp` ordering) and forwards
changed modifier masks after each key; keymap is ensured before first
keyboard focus with a rules-based fallback for headless runs.

- Verified before/after in a **nested** forked KWin (`--virtual
  --no-lockscreen` + `wev`): old lib → no modifiers event ever; new lib →
  `depressed: Shift`, shift+a decodes `utf8: 'A'`, `depressed: Control`.
- Engine hardening: `jarvis_seat.available()` negatives now re-probe (30 s
  TTL) instead of being cached forever — a pre-KWin probe used to silently
  exile all real-screen input to the shared seat (mixing). +3 tests
  (`test_jarvis_seat_routing.py`, suite 903 passed).
- **Pending user action**: run `~/projects/kwin-jarvis-fork/deploy-libkwin.sh`
  (auto-mode rightly refused to overwrite the live compositor lib) and
  **relogin**, then `scripts/jarvis_seat_type_check.py` for the live smoke.
  Fork commit `ce0cea6` on local branch `jarvis`.

## 🆕 Install opens a live scout+interview chat; tick schedule auto-seeded (2026-07-10)

Clicking "Install Proxmox Workload Manager" no longer just kicks a silent
background job — it opens a real, interactive Orin chat that scouts the
fleet live, narrates findings VM by VM, and asks the user directly in the
conversation about any VM with no recorded Purpose, saving answers as it
goes. All three UIs (desktop, web, TUI) auto-navigate the triggering client
there the moment install succeeds. The previously-manual "seed the periodic
schedule" step is now folded into install itself (detached, idempotent).

- **Caught in code review, not the initial build**: the live session was
  first wired up with `profile="coworker"`, which — verified by reading
  `createSession`'s internals directly rather than trusting an earlier
  research pass — defaults `target` to `"agent"` and spins up a full nested
  Sway/Wayland compositor + computer-use engine (~45-60s blocking) for a
  session that only ever calls proxmox-mcp tools. Fixed to an empty profile
  (→ `"coder"`), matching the recurring tick's own `createSession` call.
- Also fixed a **latent version of the same issue in the pre-existing
  recurring tick**: `createSession`'s `autoComputer` auto-spawn path never
  excluded `scheduleTargetRef`-routed (headless/scheduled) sessions, so
  ANY session routed that way — including every 5-minute tick — would
  auto-provision the same expensive nested desktop whenever a user's global
  "let Orin use a computer" setting was on. Now gated on
  `scheduleTargetRef.isEmpty()`.
- The schedule-seed exec was awaited for up to 25s for a result nothing
  downstream needed — detached, matching the existing scout-kick pattern.
- A failure opening the live chat is now surfaced in the install's
  user-facing `note`, not just a daemon log.
- Web dashboard gained a real missing piece: `chat.tsx` didn't actually
  read the `jarvis.web.openSessionId` sessionStorage handoff key —
  `sessions.tsx`'s own comment flagged this as "chat.tsx (once built)
  should do the same" — now implemented, mirroring `replay.tsx`'s existing
  handoff pattern.
- Tests: ctest 33/33, cli 187, web typecheck+build, offscreen QML smoke.
  Live pve validation pending merge to `main` (same deploy-loop constraint
  as the rest of this feature).

---

## 🆕 Proxmox VM scout: agentless guest scanning, JARVIS.md profiles, interview questions, talk-to-agent, Pinged watch rules (2026-07-09)

The always-on Proxmox workload manager can now see INSIDE the guests — with
zero per-VM agent installs (QEMU guest agent for Linux+Windows VMs, `pct
exec` for LXC) — and the user can talk to it directly from any Orin chat.

- **Scout**: one marker-delimited command battery per guest (services listed
  from cgroup dirs — `systemctl` stays denylisted), fleet scans run detached
  with live progress on the Outpost page (all three surfaces, 3s poll of
  `scout_status.json`); `outpost.install_workload` now sweeps guest agents
  and kicks an initial scout automatically.
- **JARVIS.md per VM/CT** at `/var/lib/jarvis-proxmox-agent/vms/<vmid>.md`:
  scout-owned Observed section, user-owned Purpose/Preferences preserved
  byte-for-byte across re-scans; the tick prompt makes the agent read a
  profile BEFORE tuning and respect it; re-scout is manual + agent-judged
  (no profile / stale >7d / workload mismatch).
- **Interview flow**: the agent queues ≤3 deduped questions ("What is VM 104
  for?"); the user gets an inbox ping + answerable cards on the Outpost page
  (or `proxmox_answer_question` in chat); answers land in the profile next
  tick.
- **Talk to the agent**: `proxmox_ask_agent` chat tool → task mailbox +
  `proxmox-agent-kick` (loopback `schedule.run_now`) → the reply is polled
  back into the chat in seconds, ≤5 min worst case via the tick.
- **Pinged**: named watch rules — free-text condition rules judged every
  tick and daily HH:MM rules with deterministic dueness; fired rules ping
  the inbox with what was done; managed from chat and the Outpost page.
  "Fix, don't break" is structural: the new `proxmox_guest_service` heals
  services inside guests (start/restart/status only — no stop verb, still
  zero VM-power paths anywhere in the agent's catalog).
- Tests: proxmox-mcp 89 (was 39), computer-use 900, cli 187, outpost-mcp 34,
  ctest 33/33, web typecheck + build, offscreen QML smoke — including a
  code-review pass that caught and fixed a real VM-power bypass in
  `proxmox_guest_service` (a valid systemd unit name like `poweroff.target`
  slipped past the name regex; closed with a target/power-keyword denylist,
  see `AGENTS.md`) plus a scout-status UI race, false-success reporting when
  `proxmox-scout` isn't installed, and over-eager background-poll
  registration of non-Proxmox machines. Live pve validation pending the
  merge-to-main deploy loop (the host's sparse clone tracks `main`);
  upgrade path = re-run install_workload + re-run the now-
  upserting `seed_schedule.py`.

---

## 🆕 Windows field-bug wave: driving overlay, click accuracy, Home/HUD stats, live-CPU widget (2026-07-09)

Four field-reported Windows-only bugs, all root-caused against the Linux reference
behavior and fixed on `dev` (zero behavior change on Linux — every fix is additive
`#ifdef Q_OS_WIN`/platform-guarded):

- **"Orin is using your computer" banner + glowing cursor never appeared on
  Windows.** Root cause: `windows/engine/backend_windows.py`'s `move`/`click`/
  `drag`/`scroll` reimplement the Linux `input.py` primitives via Win32
  `SendInput`, but never published to `agent_bus` (`agent_pointer.jsonl`) the way
  Linux's real-screen path does — so the desktop sidebar's pointer-tail auto-arm
  (`Bridge::readPointerTail`, `session=="real"`) never saw any events and the
  overlay (which itself was already correctly built for Windows in
  `windows/shell/WindowController.cpp`) never had anything to trigger it. Fixed
  by publishing the same bus events from the Windows backend, tagged identically
  (`session="real"` for the real screen, `"agent"` for the v2 isolated desktop).
- **Clicks sometimes landed at the wrong spot ("mouse all over the place").**
  Live-tested on a 3-monitor field machine (no DPI-scaling bug found — every
  monitor was 100%): `SendInput` can report success while the cursor never
  actually moves. Dangerous specifically because `click()`/`drag()` fire their
  button-down/up as a SEPARATE zero-relative `SendInput` call that lands
  wherever the cursor CURRENTLY is — a swallowed move makes the click land at
  the stale position. `_mouse_move_abs()` now reads back `GetCursorPos` and
  falls back to `SetCursorPos` (a different kernel path) on a mismatch.
- **Home dashboard / HUD strip showed no CPU, RAM, or NET data on Windows.**
  `Bridge::pollStats()` (`desktop/src/Bridge.cpp`, shared) was `/proc/stat` +
  `/proc/meminfo` + `/proc/net/dev` only — those paths don't exist on Windows, so
  every stat silently stayed at 0. Added a `#ifdef Q_OS_WIN` path:
  `GetSystemTimes` (CPU), `GlobalMemoryStatusEx` (RAM), `GetIfTable2` (NET, sums
  non-loopback interfaces that are up). GPU (`nvidia-smi` via `QProcess`) was
  already cross-platform and untouched.
- **A model-created "CPU widget" showed no data on Windows.** The co-work system
  prompt's `widget_live` example (`daemon/src/ControlServer.cpp`, sent to every
  session) hard-coded a Linux-only command (`top -bn1 | awk '/Cpu/{print
  100-$8}'`) — `widget_live`'s command runs through `subprocess(shell=True)`
  (`cmd.exe` on Windows), which has no `top`/`awk`, so the model's exact literal
  example produced an empty `{{value}}`. Now branches per-OS at compile time; the
  Windows example (`powershell -NoProfile -Command "(Get-Counter
  '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue"`) was
  verified live through the EXACT `subprocess.run(command, shell=True)` path
  `live_widgets.py` uses before being committed.

**Two hard-won C++/Windows build gotchas** hit while fixing the last two (see
`AGENTS.md` "New subsystems (2026-07-09)" for the durable record): MSVC's
classic preprocessor cannot parse a bare `#ifdef` sitting inside a macro call's
argument list (`QStringLiteral(...)`) — hoist to an external `#define`/`#undef`
pair instead; and `<iphlpapi.h>`/`<netioapi.h>` (`GetIfTable2`) need
`<winsock2.h>` + `<ws2tcpip.h>` included first, which doesn't happen for free
once `WIN32_LEAN_AND_MEAN` is set (it is, repo-wide, via `posix_compat.h`).

Verified: local incremental MSVC compile of `jarvisd`+`jarvis-sidebar` (clean),
`windows/engine/tests` pytest (41/41, new SetCursorPos-fallback + agent_bus
coverage), a full local `Jarvis-Setup.exe` build+install+manual test of the
driving-overlay fix. The click-accuracy and stats fixes are compile-verified
locally; the Windows CI build on this PR is the first environment that can
actually launch+exercise the new code paths at runtime (they're behind
`#ifdef Q_OS_WIN`, so they never compile at all on the Linux/AppImage CI job).

---

## 🆕 The terminal wave: jarvis CLI/TUI, true self-update, Android picker fix (2026-07-03)

- **`jarvis` — the terminal surface** (`cli/`, Linux + Windows): a Claude-Code-
  style full-screen TUI agent (streamed chat with tool cards + `/y`·`/n`
  approvals, Sessions, Memory, Skills with pin/restore, Agents, work Queue,
  Settings knobs that cycle in place) over one streaming Contract A client —
  plus `jarvis doctor` (health check with concrete fixes), `jarvis status`,
  `jarvis start|stop` (headless, no GUI), `jarvis web start`, `jarvis ask "…"`
  (one streamed turn for scripts; approvals auto-deny), `sessions`, `search`,
  `version`. 16 tests vs a scriptable fake daemon incl. 4 textual Pilot TUI
  smokes; verified live against the running daemon (real mistral turn).
  Installed by `install.sh` (cli-venv + `~/.local/bin/jarvis` symlink).
- **True release-based self-update**: AppImage replaces ITSELF in place
  (download latest GitHub release asset → ELF-magic check → atomic rename;
  new build on next launch) and packaged Windows silently runs the new
  Jarvis-Setup.exe (/CLOSEAPPLICATIONS /RESTARTAPPLICATIONS relaunches).
  Git checkouts keep pull+rebuild. New **"Install updates automatically"**
  toggle (`auto_update_apply`, default off) turns the periodic 6h check into
  hands-off auto-install with a result notification. Also fixed: the Windows
  update script read an env var nobody set, so `behind` was NEVER true —
  Windows auto-update literally could not fire before this.
- **Android**: the attach button opens the photo picker again (IconButton's
  internal clickable ate the tap after the long-press-paste change; now a
  plain gesture Box — tap = picker, long-press = clipboard paste).

## 🆕 The #76 wave: all 16 Hermes-comparison backlog items + image paste + the real Windows widget fix (2026-07-03)

Issue **#76** (the Hermes-comparison backlog) shipped **in full** on `dev` — all 16
items, the image-paste bonus, and the root-cause fix for the long-standing
"widgets never render on Windows":

**Quick wins (items 1–5):**
- **Cross-session full-text search** — `events_fts` FTS5 mirror over every stored
  turn + tool output (backfills old DBs once), `session.search` on control+device,
  `session_search` MCP tool with a ±context window. New `session_store_test`.
- **Skill lifecycle curation** — per-skill `_stats.json` (use_count / last_used_at /
  pinned, never mirrored to CLI dirs); hourly sweep ARCHIVES (never deletes) stale
  self-authored unpinned skills (`skill_archive_days`, default 30, 0=off);
  pin/restore on desktop + Android + `pin_skill`/`unarchive_skill` tools.
- **Real-time phone events** — the daemon subscribes to the phone server's WS as
  ext 100 and PUSHES `phone.event` frames to opted-in surfaces; the desktop call
  overlay + extension now react instantly (old 2s/3s polls demoted to slow
  fallbacks).
- **Tool-loop guardrails** — `ToolLoopGuard` hashes (tool,args,result) per turn:
  3 identical repeats soft-warn the brain, 5 hard-stop the turn with an error card
  + audit + a queued re-plan directive. Churn loops (same call, changing error)
  trip at 2x. New `tool_loop_guard_test`.
- **Credential pools** — several API keys per provider (comma/newline separated in
  one secrets entry); ApiBrain rotates on HTTP 429 and only fails when the pool is
  exhausted.

**Compounding (items 6–9):**
- **Context compression** — the previously-orphaned PreCompact hook FIRES when the
  estimated api-brain prompt exceeds `api_context_max_tokens`; old turns collapse
  into one labelled digest (hook can supply it; tool-result pairing preserved).
- **Durable kanban work queue** — `KanbanStore` (`work_queue` in jarvis.db) with
  priority claim / worker heartbeats / stale reclaim (survives restarts + crashes);
  5s daemon dispatcher runs ≤2 items as top-level "Queue: …" sessions and stores
  each result; `queue.*` Contract A + `queue_add/list/cancel` tools. New
  `kanban_store_test`.
- **Post-turn self-improvement** — opt-in (`self_improve=on`): a cheap async
  mistral-small review after each top-level turn may save ONE reusable fact to
  memory (tags auto+review). Silent no-op without a key.
- **Persistent goals / auto-continue** — sessions carry `goals` +
  `continuation_count`; `set_goal` tool + `session.set_goals`; with
  `auto_continue=capped|on` the daemon re-wakes the session ([AUTO-CONTINUE n/cap],
  capped=3 per real user turn, on=25 ceiling) until the model clears the goal.
- **Autonomy settings UI** on desktop (AUTONOMY card) + Android (Mode & autonomy,
  which also fills the old agent-mode/wake-notify parity gap).

**Bigger bets (items 10–16):**
- **Mixture-of-Agents** — `agent_moa` fans one question to N different
  brains/models in parallel and returns their independent answers as ADVISORY
  context (the caller decides; committee still judges). `test_moa.py`.
- **Provider registry** — gemini-*/grok-*/deepseek-* model ids auto-route to
  Google/xAI/DeepSeek (OpenAI-compatible dialect, tool loop + vision included);
  key fields on desktop + Android.
- **Pre-exec command scanner** — `cmd_scan.py` (weighted cues, ~zero false
  positives) gates bg_start/monitor/watch/widget_live commands inside the policy
  wrapper: unambiguous destruction/exfil → Allow/Deny ask; audited;
  `JARVIS_CMD_SCAN=0` off-switch. 56 tests.
- **OSV malware gate** — adding an npx/uvx MCP server queries OSV for MAL-*
  advisories BEFORE storing (fail-open offline, audited); a hit returns the
  plugins-style needs_approval so the user must consciously override. New
  `osv_advisory_test`.
- **LSP diagnostics** — `lsp_diagnostics(path)` engine tool: raw JSON-RPC to one
  live language server per language (pull + push diagnostics, idle-reaped),
  graceful "not installed" degrade. 55 tests.
- **ACP editor bridge** — new `acp-bridge/`: Zed/JetBrains drive Orin as a
  native Agent Client Protocol agent (streamed turns, tool cards, in-editor
  permission prompts) over Contract A. 10 tests + Zed snippet in its README.
- **Multi-profile isolation** — `JARVIS_CONFIG_DIR` + `JARVIS_DATA_DIR` give a
  second daemon+sidebar instance its own tokens/db/skills/ports (defaults
  byte-identical; every store now routes through the two resolvers).
- **Web dashboard** — new `web/`: a no-build static SPA (sessions/chat with
  streamed events + approvals, memory, skills, agents) speaking the extension's
  exact Contract A dialect; `python3 web/serve.py` and open it.

**Bonus — clipboard image paste, everywhere:** Ctrl+V an image into the desktop
composer (chips + ✕, image-only sends OK), paste into the extension composer,
long-press the Android attach icon. Non-vision brain/model → a FRIENDLY inline
notice naming vision-capable options, never a silent drop.

**Windows root causes (user-reported):**
- **"Widgets never render" was the FROZEN ENGINE CRASHING AT STARTUP** — stale
  PyInstaller hooks dropped jsonschema_specifications' schemas + the mcp
  dist-info, so the engine died before binding :8794 (no tools at all). Proven
  live on the win runner VM (grafting the two pieces → render_widget 200 + a
  widgets.jsonl record); build.ps1 + build-appimage.sh now pass the
  collect-data/copy-metadata flags explicitly.
- **Todos now link to their session** — the shared global engine (no
  JARVIS_AGENT_SESSION) resolves the single running session from the daemon and
  stamps it, so todo cards stop bleeding into every chat.

Verified: ctest **30/30** (4 new suites), engine pytest **576 passed + 1 skip**
(moa/cmd_scan/lsp suites added), acp-bridge **10/10**, Android `assembleDebug`,
extension + web `node --check`, live win-VM engine probe. See AGENTS.md
"New subsystems (2026-07-03)" for the gotchas.

---

## 🆕 Windows live-test round 2: codex model mismatch, Claude workspace-trust, canvas widgets (2026-07-02)

Live Windows testing after the first Windows sweep surfaced three more (all fixed on `dev`):

- **codex "model not supported" crash.** With brain=**codex** but a **claude** model still
  selected (e.g. `claude-haiku-4-5`, left over from a claude session or a global
  `default_model`), the daemon passed `-m claude-haiku-4-5` to codex → `invalid_request_error:
  "claude-haiku-4-5" is not supported when using Codex with a ChatGPT account` → `codex exited
  with code 1`. New `coerceModelForBrain()` in `makeBrain` (daemon) coerces any model that
  isn't valid for the chosen CLI brain to that brain's default (codex→gpt-5.5, claude→its
  default) — a universal guard that protects every client (desktop/extension/phone). The
  extension already resets the model on brain-change; this is the safety net.
- **Claude "workspace has not been trusted".** Headless `claude -p` ignored the project's
  `permissions.allow` ("Ignoring N permissions.allow entries … run Claude Code interactively
  here once … or set `projects[cwd].hasTrustDialogAccepted: true`"). NO CLI flag skips the
  trust gate (bypassPermissions / --dangerously-skip-permissions don't cover it, by design —
  CVE-2026-33068), so `ClaudeBrain` now pre-populates `CLAUDE_CONFIG_DIR/.claude.json` (merging,
  never clobbering) with the workspace trusted before spawning claude. Verified in
  `claude_buildargs_test`.
- **Canvas widgets never appeared** (todos already showed after round 1). `render_widget` /
  `widget_live` write to the same bus, but the **Canvas page is lazy-loaded**, so AppShell's
  `replayAllWidgets()` on tab-switch fired BEFORE the page's `Connections` handler existed and
  the replayed signals were lost. `CanvasPage.qml` now requests the replay itself in
  `Component.onCompleted` (after its handler is registered) — mirroring how the chat panel
  replays on session open. (The saved-Widgets tab already refreshed on load.)

Verified: Linux `ctest` 26/26 (incl. `gui_selftest` + the new trust assertion). Windows
runtime confirmation via CI build + the user's box.

---

## 🆕 Windows follow-ups: codex message/memory, widgets/todos display, one-paste extension pairing (2026-07-02)

Three field-reported Windows issues (#81, #82) root-caused and fixed on `dev` — the
layer *underneath* the earlier 07-02 sweep (codex now runs, but…):

- **#82 — codex could reply but got NO message and NO memory.** `CodexBrain` passed the
  prompt as an argv positional with stdin nulled (`core/src/CodexBrain.cpp`). A global
  `codex` on Windows is a `.cmd` shim; cmd.exe drops/mangles a multi-word quoted
  positional → codex received an empty prompt (and, with no real first turn, no
  `thread_id` to `resume` → no memory) — the exact bug `ClaudeBrain` already had fixed.
  Now the prompt is fed on **stdin** (`-` is codex's "read prompt from stdin" sentinel,
  cmd.exe-safe) for both `exec` and `exec resume <id>`. Verified end-to-end with real
  codex 0.135: turn 1 got the stdin message; turn 2's `resume … -` read stdin AND
  remembered turn 1. `codex_buildargs_test` updated to assert the prompt is never on
  argv.
- **#81a — the model's widgets/todos never showed.** The C++ desktop/daemon *readers*
  resolved the file bus via `QStandardPaths::GenericDataLocation` — `~/.local/share` on
  Linux (so it worked) but `%LOCALAPPDATA%` on Windows, while the Python engine + the
  SQLite DB + every store write to `~/.local/share/jarvis`. So on Windows the desktop
  read a different directory than the engine wrote. New header-only `jarvis/DataPaths.h`
  (`$XDG_DATA_HOME` or `~/.local/share`, mirroring the engine) now backs every reader
  (`Bridge`, `DeviceServer`, `ControlServer`, `WidgetLeaseRegistry`) — Linux byte-
  identical, Windows fixed. Plus: the shared global engine on Windows stamps an empty
  `session_id`, so a live plan is adopted into the active chat (replayed/foreign plans
  always carry a non-empty id, so only those are rejected — `JarvisPanel.qml`).
- **#81b — user-friendly extension pairing.** Instead of hand-copying two secrets into
  the extension, the app now mints a single-use code: **Settings → Browser Extension →
  “Generate pairing code”** (`extension.pair_start`, reusing the device `PairingManager`
  pool). The extension's Options has a **“Pair with a code”** field that redeems it at
  the loopback-only `ws://127.0.0.1:<control>/control/pair?code=…`, which vends the
  bearer + control tokens and self-closes. Same-user localhost + single-use + 5-min TTL
  (exposes nothing a local process couldn't already read from the 0600 token files); the
  manual token fields remain as a fallback. Verified end-to-end against an isolated
  jarvisd (valid code → tokens; consumed/bogus codes rejected).

Verified: Linux `ctest` 26/26 (incl. `gui_selftest` loading the full QML), extension JS
`node --check` clean, isolated-daemon pairing E2E. Windows runtime confirmation is via
the CI Windows build + the winlab VM / the user's box.

---

## 🆕 Bug sweep: Windows CLI-brain tools/skills/codex/mic + api-brain streaming (2026-07-02)

Four field-reported bugs root-caused (multi-agent investigation, each cause adversarially
verified against the code) and fixed on `dev`:

- **Windows: Claude Code got ZERO MCP tools.** The v2 ship gate means the nested agent
  desktop never comes up on Windows, the auto-computer path degraded with empty overrides,
  and claude's always-on `--strict-mcp-config` with no `--mcp-config` = zero servers. New
  `AgentDesktop::nestedDesktopSupported()` predicate (Linux true; Windows only with the
  `JARVIS_ENABLE_V2` sandbox tier) lets `makeBrain` fall back to the **global `:8794`
  registry config** for claude (+`bypassPermissions`), codex, and api sessions — the v1
  real-screen contract. Covers the resume path; Linux behavior unchanged.
- **Windows: skills never reached Claude Code** (`/internal_docs` "not available") when
  claude/codex was installed **after** Orin: mirrors only happened at skill creation and
  skip a missing `~/.claude`. New `SkillStore::syncMirrorsToCli()` re-mirrors every skill
  at daemon start — one Orin restart after installing a CLI heals it.
- **Windows: codex died with `stream did not contain valid UTF-8` (exit 1)** on every turn.
  `ensureIsolatedHome()` used `QFile::link` for `auth.json` — on Windows that writes a
  binary IShellLink `.lnk` payload INTO the file, which codex `read_to_string`s at startup.
  Reproduced byte-for-byte on the win10 VM (codex-cli 0.142.5). Now: hard link (write-through)
  with copy fallback, re-mirrored every launch so corrupted session homes self-heal.
- **api brain (mistral/openai/ollama + anthropic dialect): every reply fragmented into a
  bubble per SSE chunk** ("Good" / "morning, sir.") on all platforms — ApiBrain emitted a
  full `Message` event per streamed delta, but Contract B treats `Message` as one complete
  bubble (QML appends one bubble per event; the daemon persists one history row per event;
  TTS speaks each event). Deltas are now buffered and flushed as ONE Message per segment
  (at `finishTurn()`, before tool_calls attach, and on cancel so a Stop still shows partial
  text). Regression tests for both SSE dialects via a new `ingestSseDataForTest()` seam.
- **Windows: mic didn't work at all** — every wired capture path (chat dictation,
  hands-free voice mode, voice-clone recorder) shelled out to `pw-record` (PipeWire), and
  `voiceAvailable()` gated on it, hiding the mic button on Windows entirely. All three paths
  now fall back to the already-linked Qt Multimedia `QAudioSource` (WASAPI) capture when
  `pw-record` is absent; the hands-free path feeds the same energy VAD raw PCM. STT was
  never the blocker (cloud Voxtral over HTTP).

---

## 🆕 Feature wave: permission engine, self-healing, committee, watcher, replay + UX bug sweep (2026-07-01)

Closed the six open feature/bug issues and a full adversarial UX bug hunt, all on `dev`:

- **Trust Policies — a real permission engine (#71).** Per-tool / per-app `allow`/`ask`/`deny`
  rules ENFORCED at the tool layer, not just advice to the model. The computer-use engine wraps
  every tool call (`computer_use_mcp/policy.py`): deny fails the call, ask pops an approval on
  desktop **and** phone via the ask-bus. Rules live in `~/.config/jarvis/trust_policies.json`
  (glob tool + focused-app, most-specific-wins, case-insensitive app match). Core `TrustPolicyStore`
  (CRUD + evaluation mirror + preamble clause), Contract A `policy.*` on control + device
  (mutations biometric-tier on the phone), and a **Settings → Permissions** card on desktop + Android
  (default-action selector, click-to-cycle rule pills, add/remove). Tests: `trust_policy_test`
  (ctest) + `test_policy.py` (12).
- **Failure Self-Healing Loop (#67).** Every input tool (click/drag/scroll/key/type) runs through
  `selfheal.run()`: transient retry with backoff, then a 32×32 screen-hash before/after to detect a
  no-op (result carries `self_heal.screen_changed`+hint), escalating to a hard "RE-PLAN" after 3
  consecutive misses. Audited to `selfheal_log.jsonl`. `JARVIS_SELF_HEAL=0` disables verification.
  `test_selfheal.py` (10).
- **Agent Committee Mode (#69).** `agent_committee(task, strategies[], judge=true)` — N subagents
  solve one task in parallel with different strategies, an optional judge subagent picks/merges the
  best. Rides the existing agents.dispatch/result machinery. `test_committee.py` (5).
- **Proactive Anomaly Watcher (#68).** `watch(command, …)` background job that learns a baseline
  then wakes the session ONLY on a genuine deviation — numeric (running mean/stddev, sensitivity
  low/med/high with an absolute floor) or lines (a new log line). Low-noise: silent during learning;
  one alert per anomaly then cooldown. Pure detection core `anomaly.py`; `test_anomaly.py` (10).
- **Mission Control Replay (#66).** A desktop REPLAY page scrubs any past session like a video —
  the full normalized timeline rebuilt through the live `ChatDelegate` (messages, thoughts, tool
  calls, screenshots, diffs) with ⏮/step/play/⏭, a scrubber, and 0.5–4× speed. `bridge.loadReplay`
  reuses session.history un-gated + with per-event ts; opened via a "▶ Replay" row action on Sessions.
- **Subagent lifecycle + #72 fix.** Subagents are now first-class-distinct from chats: children
  never list as top-level rows (desktop/Android/extension), the parent shows a live "✦ n" badge,
  finished subagents disappear from the peek, and the daemon no longer fans `session.opened`/FCM for
  child sessions. Fixed the root of "every chat pops out as a subagent" (empty-sessionId parent match),
  the un-dismissable peek (sticky snooze), the blank Settings page (Repeater count derived from the
  nav list), and the stranded COMPUTER "Full" button (contextual rail item).
- **Adversarial bug sweep (8 fixed).** Incl. HIGH: Android app-open fingerprint gate bypassed by
  chat deep-links (now gated on every path); extension side panel leaking other chats' events/widgets
  into a fresh panel (strict session scoping). Plus stale `agent_desktop.info` replies, subagent
  "task done" toast spam, `agent_start` wrong-parent attribution, extension subagent rows + missing
  delete. See git log on `dev`.
- **Chrome extension:** the model's todo/plan now renders in a dedicated collapsible **PLAN panel**
  above the transcript (not inline), cleared per session.
- **Phone auto-jump fixed:** opening the Android app no longer teleports you into a session started
  on the desktop.

Backlogs opened as issues: **#75** (Windows own-seat / second-cursor engineering plan) and **#76**
(Hermes-comparison feature backlog). Verified: ctest 26/26, engine pytest 460, gui_selftest, Android
`assembleDebug`, extension JS syntax.

---

## 🆕 Windows edition VM-verified + winlab test harness (2026-06-30)

Stood up **`windows/testlab/winlab.py`** — a local "GitHub Actions" that drives a real **Windows 11
Pro** VM from the Linux box over SSH (build / install / launch / **screenshot** / PowerShell), closing
the loop CI can't (CI compiles but never *runs* the GUI). `winlab shot`/`launch` run inside the
**interactive console session** (transient scheduled task, Interactive principal) — SSH session 0 can't
see the desktop. Using it, three real shipping bugs in the Windows `.exe` were caught **and fixed**, each
re-verified on the VM:

- **`MSVCP140.dll` not found** — `windeployqt --compiler-runtime` ships `vc_redist.exe` (an installer
  the setup never ran), not the loose CRT DLLs. `build.ps1` now copies `msvcp140*/vcruntime140*/concrt140`
  next to the exes (hard-fails the build if `MSVCP140.dll` is missing). → jarvisd/sidebar now launch +
  **serve on 8795/8796**, no error dialog.
- **Engine crashed on launch** (`ModuleNotFoundError: dbus_fast`) — the shared import chain pulls in
  Linux-only modules (`kwin_bridge`→`dbus_fast`, `evdev`, …). `server_windows.py` now installs a
  meta-path **stub finder** (handles import + class-base + decorator + constructor use) so the import
  succeeds; the Win32 backend is monkeypatched over the real primitives. → the engine **binds
  `0.0.0.0:8794`** (all MCP tools).
- **Engine never auto-started** — `jarvis-launch.vbs`/`jarvis-start.cmd` looked for `engine\jarvis-engine.exe`
  but PyInstaller nests it at `engine\jarvis-engine\jarvis-engine.exe`. Fixed both launcher paths.

**Linux AppImage** (`packaging/build-appimage.sh` + `linux-release.yml`): now **builds** in a `fedora:44`
container (Qt 6.11 / LayerShellQt 6.7 / libwayland all consistent — the ubuntu path fought Qt 6.4.2
qmlcachegen segfaults and `wl_fixes` skew). **Not yet shippable**: the bundled binaries segfault at
runtime where the system ones don't (jarvisd in QtWebSockets; sidebar in QtMultimedia/PipeWire teardown
— bundled-Qt symbol interposition). The CI stays **selftest-gated** so it auto-attaches once cracked.
Windows **v2** isolated "beside-you" desktop (Sandbox tier) is implemented + committed but can't be
validated on the VM (no SLAT exposed → Sandbox can't run; daemon falls back to v1 take-over).

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
used everywhere Orin speaks: desktop TTS / voice mode, the phone app's spoken replies, and
**phone calls** (when it calls you and when it answers). **Nothing removed:** `jarvice` is
seeded as the default "Orin" voice; every prior picker/behavior stays.

- **Daemon owns the library** (`~/.config/jarvis/voices/` clips + a `voices.json` manifest):
  new core `VoiceLibrary` (CRUD, slug, seed-from-disk, optional ffmpeg clean/trim;
  `voice_library_test`). Contract A `voice.create_clone` / `delete_clone` / `set_default` /
  `rename_clone` / `preview_clone` on **control + device** surfaces; `voice.list_voices`
  merges the named voices ahead of the stock presets.
- **"Set as default" propagates:** desktop + app key off `tts_voice` (instant); for **calls**
  the daemon rewrites `MISTRAL_TTS_REF_AUDIO_FILE` in `phone.env` and **restarts
  `jarvis-phone.service`** (~1–2 s; vendored server otherwise untouched on the global path).
- **UI in both places:** a "Default Voice" card in **Settings → Voice** on desktop
  (`SettingsPage.qml` + `Bridge` `pw-record`/upload) and the **Orin Android app** (v0.12.0,
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
  Orin's `MainActivity.onCreate` now starts it on **every** launch (any tab) + re-enables
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

Inbound calls to the Twilio number now reach Orin and **talk back in the user's own
cloned voice**; the brain can call/text; and the desktop/Chrome phone UIs gained the
missing call features. All shipped today.

**Call path (the number answers + speaks):**
- **Instant hang-up** → caller wasn't allow-listed (the handler rejects non-allowlisted
  callers when screening is off). Fixed by allow-listing the user's number.
- **Silent call** → Mistral `/audio/speech` now rejects a `speed` field (HTTP 422), so
  every TTS failed mid-call. Removed `speed` from `phone/server/src/mistral/tts.ts`.
- **Custom cloned voice** → calls send the user's reference clip as `ref_audio` (zero-shot
  clone) via `MISTRAL_TTS_REF_AUDIO_FILE`, instead of the stock voice.
- **Greets by name** → the adapter says "Orin here", not "Codex here" (`AGENT_PHONE_NAME`).
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

## Android = the original phone app verbatim + Orin answers inbound (2026-06-29)

- **Verbatim Android port (Orin v0.11.0).** The **entire** original agent-phone Android app
  — all 60 files / ~11,882 lines, package `com.agentphone.*` — is copied **byte-for-byte** into
  the one Orin APK; nothing reimplemented or removed. The **Phone tab launches the real
  `com.agentphone.MainActivity`**, so every original screen/setting/button/flow is present
  (Calls · Inbox · Agents · HUD · Settings, setup wizard, agent config, call screening, SMS
  agent, diagnostics, history, enroll, relay puck, call activities/services, on-device sherpa
  TTS). The earlier reimplemented phone UI was deleted. Build green (`assembleDebug`).
- **Orin answers when you call OR text.** Ext **101** is the inbound **and** SMS agent; the
  phone server spawns Orin's brain adapter **headlessly** on inbound and bridges voice (call)
  or a text reply (SMS). SMS agent enabled → 101; replies go out free via the **device SIM**
  (Twilio toll-free SMS is A2P-gated). Orin can **call/text back mid-conversation**.
- **Orin is now THE one for the number.** The app default server URL is repointed `:8799` →
  **`:8801`** (Orin), and the Tailscale funnel `/twilio` is repointed to `:8801` so inbound
  calls/texts hit Jarvis (ext 101), not the original. The **original `:8799` is left running,
  untouched** (it just no longer receives the Twilio webhook).
- **Tools + skill + docs.** All **~56** phone tools reach the brain (`seedPhoneMcp`). A builtin
  **`/phone` skill** (`seedPhoneSkill`) is the playbook; `internal_docs` bumped to v3 with the
  inbound-wake behavior.

See [`PHONE.md`](PHONE.md).

---

## Full phone UI parity on all 3 surfaces (2026-06-28)

The entire **agent-phone app UI** is now embedded in Orin — no new app. A full-screen
**Phone section** (Calls · Inbox · Agents · HUD · Settings) ships on all three surfaces:
**desktop QML**, **Android Compose (v0.10.6+)**, and **Chrome MV3**. Android hides
Orin's main bottom nav while inside Phone (full-screen), restoring it on back.

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
  Orin-managed env (`~/.config/jarvis/phone.env`), wired to the brain via
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
  Orin chat).
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

**Orin** is one AI co-worker you can drive from your **Linux desktop**, your **Android
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
    Orin just toggles the same process, so stale page content survived). Now a client declares the
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
  actually works on this PipeWire box; Qt Multimedia/WASAPI fallback where pw-record is
  absent — see the 2026-07-02 sweep), RMS VAD calibrated to the mic noise floor (~0.5s
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
