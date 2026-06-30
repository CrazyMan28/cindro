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

- **Phase 0 (build/unit-test on Linux now):** gap-#1 alias in `windows/engine/backend_windows.py`
  + test; `windows/isolation/detect.ps1` (edition/VT-x/DisposableClientVM/Hyper-V → mode);
  the new `AgentDesktop.cpp` orchestrator + `windows/isolation/relay/` (compile in the windows
  CMake target — pure Qt+QProcess+QTcp; can't *run* on Linux but compiles); CMake wiring.
- **Phase 1 (Sandbox, the default — validate on Win Pro):** `windows/isolation/sandbox/
  jarvis-agent.wsb.in` (MappedFolder engine read-only, LogonCommand→bootstrap.ps1, tokens
  @PORT@/@BEARER@/@HOSTIP@) + `bootstrap.ps1` (set env, start relay/open-firewall, launch
  jarvis-engine.exe); `AgentDesktop::ensure()` renders+launches the sandbox, starts the host
  relay, waits for health.
- **Phase 2 (RDP child session):** `WTSEnableChildSessions(TRUE)` + RDP-ActiveX
  `ConnectToChildSession` + a Session-0 broker (`WTSQueryUserToken`→`CreateProcessAsUser`) to
  launch the engine in the child; `engineBase()` reaches it directly. Keep-alive: a virtual
  display + `RemoteDesktop_SuppressWhenMinimized=2` so capture never blacks out.
- **Phase 3 (Hyper-V):** boot a prepared guest with the engine as an auto-start service; portproxy.

**Fallback (already in place):** auto-detect finds nothing (Home / VT-x off / Jarvis itself in a
non-nested VM) → `ensure()` returns `up=false` (typed reason) → v1 real-screen take-over
(`which="active"`, consent + "Jarvis is driving" banner). No new code.

> Honest constraint: this compiles via the Windows CI, but actually spinning a Sandbox/child
> session can only be validated on a real **Windows Pro/Ent** box with virtualization on.
