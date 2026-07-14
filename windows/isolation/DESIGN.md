# Windows v2 — isolated "beside-you" agent desktop (design)

Goal: match Linux's nested-Sway + KWin-multi-seat (agent works on its OWN screen with its
OWN input, beside you) on Windows. From a 7-angle research pass (OpenAI Operator/ChatGPT-agent
= cloud "virtual computer"; Anthropic CU = Docker+Xvfb+VNC; Codex-on-Windows uses **Windows
Sandbox**; MS **WindowsAgentArena** runs agents in isolated Hyper-V/Azure VMs). The industry
pattern is *not* sharing the real screen — it's an **isolated desktop the agent drives, streamed
to a side pane**, with a take-over button.

## Key insight (makes this small, not a rewrite)

The Windows engine backend (`windows/engine/backend_windows.py`) injects input via Win32
`SendInput` and captures via `mss` — both **scoped to the desktop the process runs in**. So if
`server_windows.py` runs **inside an isolated Windows desktop** (Sandbox / RDP child session /
VM), its input + capture hit **only that desktop** — the Windows realization of Linux's nested
compositor seat. Input isolation becomes a property of the OS boundary, not a cursor trick.

And Jarvis's existing mirror already does the rest: `DeviceServer::startPump` pulls
`http://127.0.0.1:<port>/video/mjpeg` (per-session bearer) → device channel + `FrameProvider` →
QML; the brain gets the same per-session MCP url+bearer. So "run the engine inside the isolated
desktop" reuses the ENTIRE existing pipeline with **two `windows/`-local changes**:

1. **`which="agent"` alias** — env `JARVIS_AGENT_INSANDBOX=1` makes `backend_windows.get_session("agent")`
   return the in-sandbox desktop (today it raises = Linux-only). The daemon's `/video/mjpeg`
   defaults to `which="agent"`, so this is load-bearing. (Edit lives in `windows/engine/`.)
2. **Reachability** — the engine binds `0.0.0.0:<port>` inside; the host daemon needs it at
   `127.0.0.1:<port>` (what `AgentDesktop::engineBase()` returns + the brain's MCP config bakes
   in). Child-session/same-host VM = free (loopback is host-global). Sandbox/NAT'd VM = a tiny
   reverse-tunnel (in-sandbox dials OUT to the host gateway) or `netsh portproxy`.

**Zero edits to `core/`/`daemon/`/`desktop/`.** All new code in `windows/`. The current
`windows/shell/AgentDesktop.cpp` already keeps the portable accessors verbatim — only the
`ensure()/teardown()/sweepOrphans()` bodies change (provision boundary + start engine inside).

## Isolation tiers (config knob `windows.isolation.mode`, auto-detected)

| Mode | Isolated input | Beside-you | Persistent | SKU/HW | Reachability | Use |
|---|---|---|---|---|---|---|
| **sandbox** (default) | yes (Hyper-V micro-VM) | yes | no (disposable — a feature) | Pro/Ent/Edu + VT-x, single instance, not nested | reverse-tunnel / portproxy | default disposable agent desktop |
| **childsession** | yes (own session) | yes (MS concurrent path) | until logoff, one child | Pro+; parent stays logged in | **none** (loopback host-global) | same-desktop, no VM, no relay |
| **hyperv** | yes (HW) | yes | yes, multi-instance | Pro+ Hyper-V | portproxy/NAT | persistent / untrusted / destructive |
| **takeover** (fallback) | no (shared) | no | n/a | any (Home, no-virt) | n/a | already-shipping v1 real-screen |

Rejected: virtual-display-driver alone (renders but ONE shared input queue — user's cursor
jumps); Win32 `CreateDesktop` alone (only the input desktop is DWM-composited — background
captures black + rejects `SendInput`); rdpwrap (per-update breakage, AV-flagged).

## Flow

```
createSession(target="agent") → AgentDesktop::ensure(sid)  [windows/shell/AgentDesktop.cpp NEW body]
  port=nextPort(); bearer=genBearer()                       (reuse verbatim reservation logic)
  provision isolated desktop (mode-dispatched):
    sandbox      → render jarvis-agent.wsb, QProcess WindowsSandbox.exe <wsb>
    childsession → WTSEnableChildSessions + CreateProcessAsUser into the child session
    hyperv       → boot guest, ensure engine service
  start engine INSIDE it, bound 0.0.0.0:<port>, env COMPUTER_USE_PORT/BEARER + JARVIS_AGENT_INSANDBOX=1
  ensure host reachability at 127.0.0.1:<port> (relay/portproxy for sandbox/NAT; none for childsession)
  waitForEngineHealth() → waitForEngineReady()              (copy the Qt waiters from Linux AgentDesktop)
  m_desks[sid]={port,bearer,up=true}
  ── everything below UNCHANGED ──
  brain gets MCP url+bearer → which="agent" tools ;  DeviceServer pump → /video/mjpeg → FrameProvider → QML
```

## Phased build

- **Phase 0 (build/unit-test on Linux now) — DONE:** gap-#1 alias in
  `windows/engine/backend_windows.py` + tests (`windows/engine/tests`, 30 passing);
  `windows/isolation/detect.ps1` (edition/VT-x/DisposableClientVM/Hyper-V → mode); the
  `AgentDesktop.cpp` orchestrator + `windows/isolation/relay/` (pure Qt+QProcess+QTcp; compiles in
  the windows CMake target, can't *run* on Linux); CMake wiring.
- **Phase 1 (Sandbox, the default) — DONE, validated end-to-end on real Windows 11 Pro
  hardware (2026-07-13, first time ever — CI can't boot nested Hyper-V so this path only
  ever compiled before):**
  `windows/isolation/sandbox/jarvis-agent.wsb.in` (MappedFolder engine read-only,
  LogonCommand→bootstrap.ps1, tokens @PORT@/@BEARER@/@RENDEZVOUS@/@HOSTIP@/@SESSION@) +
  `bootstrap.ps1` (set env incl. `JARVIS_AGENT_INSANDBOX=1` + a truthy `JARVIS_AGENT_WAYLAND_DISPLAY`
  so the deep `/ready` grab-gate stays armed, write the engine config, launch jarvis-engine.exe +
  the reverse-tunnel dialer); `AgentDesktop::ensure()` renders+launches the sandbox, starts the
  in-process host relay, and waits for `/health` then `/ready`. Completed the tier with: a
  **single-instance guard** (Windows Sandbox is one-per-host → typed `sandbox_busy` degrade); a
  **firewall allow-rule** on the rendezvous port (`addRelayFirewallRule`, dropped in `teardown()`)
  so the in-sandbox dialer's inbound connect is permitted on a default-firewall box; a
  **mode-specific cold-boot budget** (~120s, `JARVIS_SANDBOX_STARTUP_MS`) for the health/ready
  waiters; and **launch-time `detect.ps1` wiring** (`jarvis-start.cmd` / `jarvis-launch.vbs` export
  `JARVIS_WINDOWS_ISOLATION_MODE`) so a Home/no-virt box auto-selects `takeover`.
  Real-hardware validation surfaced and fixed four bugs the CI-only path could never catch: (1)
  `bootstrap.ps1`'s logger called `Write-Host`, which deadlocks forever under Sandbox's
  non-interactive `LogonCommand` (no attached console to drain it) — logger is file-only
  (`Add-Content`) now. (2) The **`d.sway` liveness-tracking assumption above was WRONG**:
  `WindowsSandbox.exe` is actually a thin launcher that exits within ~1s of a successful launch,
  handing the live box off to service-hosted `WindowsSandboxRemoteSession`/`WindowsSandboxServer`/
  `vmmemWindowsSandbox` processes — treating its exit as "the box died" made every real launch fail
  on the very first poll. The health/ready waiters now rely purely on the HTTP poll + timeout
  budget, and `closeSandboxHostProcesses()` (by image name) replaced `killProc(d.sway)` for
  teardown. (3) The rendered `.wsb` carried an XML prolog + a multi-line doc comment ahead of
  `<Configuration>`; Windows Sandbox's config reader silently treats that as unparseable and falls
  back to a bare default sandbox with **no** `LogonCommand` at all — the VM boots and stays alive,
  but nothing the config asked for ever runs, with zero surfaced error. Fixed by emitting the file
  starting directly at `<Configuration>` (docs live only in `.wsb.in`) and XML-escaping every
  substituted token. (4) The first HTTP-polling rewrite (fixing bug 2's crash) blocked the whole
  Qt thread via `QThread::msleep()` — but that same thread's event loop is what the in-process
  `ReverseTunnel` needs running to accept the sandbox's incoming rendezvous connection, so the
  fix for one bug silently reintroduced a different deadlock (kernel-level TCP connect succeeded;
  pairing never dispatched). Rewritten to be `QEventLoop`/`QTimer`-driven so the thread keeps
  pumping, while still avoiding the original `QNetworkAccessManager`/`QNetworkReply` pattern.
- **Phase 2 (RDP child session):** `WTSEnableChildSessions(TRUE)` + RDP-ActiveX
  `ConnectToChildSession` + a Session-0 broker (`WTSQueryUserToken`→`CreateProcessAsUser`) to
  launch the engine in the child; `engineBase()` reaches it directly. Keep-alive: a virtual
  display + `RemoteDesktop_SuppressWhenMinimized=2` so capture never blacks out.
- **Phase 3 (Hyper-V):** boot a prepared guest with the engine as an auto-start service; portproxy.

**Fallback (already in place):** auto-detect finds nothing (Home / VT-x off / Jarvis itself in a
non-nested VM) → `ensure()` returns `up=false` (typed reason) → v1 real-screen take-over
(`which="active"`, consent + "Jarvis is driving" banner). No new code.

> Status: the **sandbox** tier is validated end-to-end on real Windows 11 Pro hardware
> (2026-07-13) — `session.create` with a coworker profile genuinely returns
> `agent_desktop.up: true`, confirmed twice independently. Still gated behind
> `JARVIS_ENABLE_V2=1` (see `resolveMode()` in `windows/shell/AgentDesktop.cpp`) pending
> validation across a wider range of real machines before it becomes the default; `takeover`
> remains the safe out-of-the-box behavior until then. **childsession**/**hyperv** (Phases 2/3)
> are still unimplemented stubs — only *sandbox* has been built and proven.
