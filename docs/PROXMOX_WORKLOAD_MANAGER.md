# Proxmox Workload Manager — an always-on Jarvis agent on the Proxmox host

An always-on agent that lives directly ON a Proxmox host, checks up on VM
resource usage every few minutes, and bumps CPU cores / RAM on congested VMs
within safe limits — **it never restarts, stops, or starts a VM on its own.**
It survives the user's laptop being off (its brain is Mistral via the direct
API, not the Claude Code CLI), keeps its own durable memory of every decision,
and enrolls as a visible agent via Project Tracker so the user's local Jarvis
can check in on it and ask for a report.

It is deployed and managed as a first-class Outpost feature — installed onto
a paired machine with one action, surfaced in the desktop GUI, the (Python)
TUI, and the web dashboard, all inside the existing Outpost page.

## Non-negotiable safety invariant

**Autonomous CPU/RAM tuning is fine; autonomous restarts are not.** This is
enforced structurally, not just by prompting:

- The scheduled agent's own MCP tool catalog (`proxmox-mcp/tools_proxmox.py`)
  never registers a restart/stop/start tool at all — the LLM has no way to
  even try.
- The ONLY code path anywhere in this feature that runs `qm reboot` is the
  local daemon's `proxmox.restart_vm` RPC (`handleProxmoxRestartVm` in
  `daemon/src/ControlServer.cpp`), which is reachable only from a
  UI-triggered, explicitly-confirmed action (desktop/TUI/web) — never from
  the scheduled agent's tool catalog, never automatically.
- When a resource change can't be hot-applied (no CPU/memory hotplug on that
  VM), `proxmox_tune` still writes the config change (Proxmox stores it as
  pending) and sets `pending_restart=true` in its state — it does NOT
  restart the VM to force it live.

## Tuning scope

All VMs are in scope by default (including CI runner VMs) — the exclusion
mechanism is a **blocklist**, not an allowlist, editable from any of the
three UI surfaces once a VM shows up in the inventory, via the daemon's
`proxmox.set_blocklist` RPC (full replace — this is the user-authoritative
path).

The scheduled agent has its OWN blocklist tool, `proxmox_add_to_blocklist`,
and it is deliberately **additive-only**: the agent can protect a VM it
decides looks risky, but it can never remove a VM the user (or a previous
tick) already blocklisted. The blocklist is a safety rail on the agent —
letting the agent wholesale-replace it (as an earlier version of this tool
did) would let it silently undo the user's own protections.

## Architecture

```
Proxmox host (e.g. "pve")
 ├─ outpost-agent                (existing — pairing/exec relay)
 ├─ proxmox-mcp   :8799          (this feature — tool server the agent calls)
 │   proxmox_mcp/tools_proxmox.py: proxmox_status, proxmox_tune,
 │   proxmox_guest_exec, proxmox_get_directives, proxmox_get_blocklist,
 │   proxmox_add_to_blocklist (additive-only), remember, recall, project_tracker_checkin,
 │   project_tracker_report — NO restart tool, ever.
 └─ jarvisd (headless, its OWN profile) — Scheduler fires an ApiBrain/Mistral
     session every `check_interval_minutes`; mcpEndpoint routed at
     proxmox-mcp instead of the desktop engine (see "Routing", below).

Local daemon (the user's laptop)
 └─ new proxmox.* RPCs — every one is an outpost.exec proxy to the Proxmox
     host, including the ONLY restart path (proxmox.restart_vm).
 └─ new computer_use_mcp chat tools — proxmox_check_status/get_report/
     give_direction/agent_checkin — so a plain chat ("check up on proxmox")
     has something to reach for. These live in Jarvis's OWN built-in MCP
     server (already registered/on for every session) — this is NOT a
     separate MCP server that needs its own registration step.
```

### Routing (how a schedule ends up calling proxmox-mcp instead of the desktop engine)

`ScheduleRow::targetRef` (a pre-existing free-text field, previously unused
end-to-end) is threaded through `fireScheduledJob` → `createSession`'s new
`scheduleTargetRef` param → the new `SessionRow::targetRef` column
(`core/include/jarvis/SessionStore.h`, migration in `SessionStore.cpp`). In
`ControlServer::makeBrain`'s `api`-brain branch, a `targetRef` starting with
`"proxmox-"` routes `ApiBrain::Options::mcpEndpoint`/`mcpBearer` at
`McpRegistry::proxmoxAgentEndpoint()` (`http://127.0.0.1:8799/mcp`, fixed —
proxmox-mcp and the jarvisd driving it are always co-located) instead of the
desktop's built-in engine, and sets a generous 429 backoff
(`maxBackoffRetries=6`, base 3s, cap 120s — see below) since this session
must never just die on a transient rate limit.

### 429 resilience (ApiBrain)

`core/src/ApiBrain.cpp` already rotated across a credential pool on HTTP 429;
it now ALSO backs off and retries (exponential + full jitter,
`ApiBrain::backoffDelayMs`) once the pool is exhausted, up to
`Options::maxBackoffRetries` times (0 = today's fail-fast behavior, unchanged
for interactive desktop sessions — this is strictly additive resilience,
opted into per-session).

## Bringing it up

1. **Pair the Proxmox host itself via Outpost** (one-time), same flow as any
   other machine — see `docs/OUTPOST.md`.
2. **Click "Install Proxmox Workload Manager"** on that machine from any of
   the three UI surfaces (or call `outpost.install_workload {machine}`
   directly) — this one action does everything below, all via
   `outpost.exec`/`writeRemoteFile` (no manual SSH needed):
   - **Preflight**: confirms the machine actually has `qm`/`pvesh` on PATH —
     refuses with `not_a_proxmox_host` otherwise.
   - **Config + secrets**: seeds `/etc/jarvis-proxmox-agent/{config.toml,
     blocklist.json (empty — all VMs in scope), mcp_token,
     project_tracker_token}` and `/etc/jarvis-proxmox-agent/jarvisd/secrets.json`
     (`{"mistral": "<your locally-configured Mistral key>"}`) via base64-over-
     exec (sidesteps shell-quoting entirely — see `ControlServer::writeRemoteFile`).
     Fails with `no_mistral_key` if you don't have one configured locally.
   - **proxmox-mcp**: a shallow, sparse `git clone` of just the `proxmox-mcp/`
     directory from the repo (`main` branch) into
     `/opt/jarvis-proxmox-agent/src`, then its own venv + `pip install`.
     **The repo is PRIVATE**, so this (and the release fetch below) needs a
     GitHub token configured locally as the `github` API key (Settings → API
     keys); the installer pushes it to
     `/etc/jarvis-proxmox-agent/github_token` (0600) and git reads it via a
     `GIT_ASKPASS` helper so it never appears in `ps`. Without one, both
     GitHub steps run anonymously and fail on a private repo.
   - **jarvisd**: fetches the latest GitHub Release's AppImage (via the
     GitHub API, `/repos/CrazyMan28/jarvis/releases/latest`) and
     `--appimage-extract`s it into `/opt/jarvis-proxmox-agent/appimage/` — the
     AppImage bundles its own Qt6/libssh/etc, so it only depends on the host's
     glibc/kernel ABI (matching the CI-pinned build baseline), sidestepping
     any Linux-distro/library-version mismatch between your dev box and the
     Proxmox host. **This is also why a plain binary transfer through
     `writeRemoteFile` isn't used for jarvisd itself** — at ~300MB it's far
     past what's reasonable to push as a single base64-encoded shell command;
     having the remote host pull it directly avoids that entirely.
   - **systemd units**: writes both `proxmox-mcp/packaging/*.service` files
     (embedded verbatim in `handleOutpostInstallWorkload` — keep them in sync
     if you edit either `.service` file) to `/etc/systemd/system/`, then
     `daemon-reload` + `enable --now` both.
3. **KNOWN GAP — seed the schedule row.** The periodic tick is one
   `schedule.create` row (cron `"every Nm"`, `targetRef="proxmox-<hostname>"`,
   a fixed prompt telling the brain to check directives, check status, tune
   what's congested, remember every decision, check in with Project
   Tracker, and never attempt a restart) that must be created **on pve's own
   jarvisd**, over ITS OWN loopback control API (`ControlServer` is
   loopback-only by design — see `AGENTS.md`'s Conventions section — so the
   laptop can't call it directly, only `outpost.exec` reaches the host at
   all). This is still a manual one-time step after install — not yet
   wrapped into `outpost.install_workload`.

## MCP tools

### On the Proxmox host (`proxmox-mcp`, called by the scheduled brain)

| Tool | Signature | Notes |
|---|---|---|
| `proxmox_status` | `() -> {node, host:{cores,mem_mb,...}, vms:[...], thresholds}` | Call first every tick. |
| `proxmox_tune` | `(vmid, cores=0, memory_mb=0, reason="") -> {ok, reason, cores, memory_mb, applied_live_cores, applied_live_memory, pending_restart}` | Enforces blocklist/cooldown/headroom/step-cap/per-VM-cap; hotplugs live where possible. **Never restarts.** |
| `proxmox_guest_exec` | `(vmid, argv, timeout_sec=30.0) -> {ok, exit_code, out, err}` | Read-only diagnostics INSIDE the guest via the QEMU Guest Agent (`qm guest exec`). Rejects argv resembling a restart/shutdown/power command (`_GUEST_EXEC_DENYLIST` in `proxmox_ops.py`) — otherwise this would be a second, unguarded way to restart a VM. Requires the guest agent running in that VM. |
| `proxmox_get_directives` | `() -> {directives:[{text, at}]}` | Consumes (clears) any pending user instructions queued via `proxmox.send_directive`. Call at the START of every tick. Guidance only — doesn't bypass any safety rail, and there's still no restart tool. |
| `proxmox_get_blocklist` / `proxmox_add_to_blocklist` | `() -> {vmids}` / `(vmids, reason="") -> {ok, vmids}` | `proxmox_add_to_blocklist` is ADDITIVE ONLY (union, never a replace) — the agent can protect a VM, never unprotect one. |
| `remember` / `recall` | `(text, tags="")` / `(query="", limit=20)` | Local, durable SQLite+FTS5 (`/var/lib/jarvis-proxmox-agent/memory.db`) — survives the laptop being off. |
| `project_tracker_checkin` / `project_tracker_report` | `(status="idle")` / `(summary)` | Enrolls as `proxmox-<hostname>` under `proj-jarvis`. |

### On the laptop (`computer_use_mcp`, for a plain chat)

| Tool | Signature | Notes |
|---|---|---|
| `proxmox_check_status` | `(machine) -> proxmox.status result` | "Check up on proxmox" → call this + `proxmox_get_report`. |
| `proxmox_get_report` | `(machine) -> proxmox.report result` | Sync-then-recall from the remote memory db into local agent-scoped memory (`agent="proxmox-<hostname>"`), watermarked by the newest `created` already synced. |
| `proxmox_give_direction` | `(machine, text) -> {ok}` | Queues a directive for the next tick. |
| `proxmox_agent_checkin` | `() -> {agents:[...]}` | Liveness via Project Tracker's `agent_list_active`, filtered to `proxmox-*`. |

These ship inside Jarvis's own built-in MCP server — no separate server to
register, no "only visible to Claude Code" gap.

## Config reference (`/etc/jarvis-proxmox-agent/config.toml`)

| Key | Default | Meaning |
|---|---|---|
| `check_interval_minutes` | 5 | Schedule cadence. |
| `cooldown_minutes` | 15 | Minimum gap between two tune actions on the SAME VM. |
| `reserve_cores` / `reserve_mem_mb` | 2 / 4096 | Host headroom never touched. |
| `bump_step_cores` / `bump_step_mem_mb` | 2 / 2048 | Max increase per tune action, regardless of what's requested. |
| `max_cores_per_vm` / `max_mem_mb_per_vm` | 16 / 32768 | Hard per-VM ceiling. |
| `cpu_congested_pct` / `mem_congested_pct` | 85.0 / 90.0 | Congestion thresholds. |

`/etc/jarvis-proxmox-agent/blocklist.json` — `{"vmids": [...]}`, empty by
default (all VMs in scope).

## Troubleshooting

1. **`outpost.install_workload` fails with `not_a_proxmox_host`** — the
   paired machine has no `qm`/`pvesh` on PATH; you paired the wrong machine
   or the check ran before Proxmox tooling was on PATH for that shell.
2. **`no_mistral_key`** — configure a Mistral key locally first (Settings →
   API keys); the installer reads it from `m_settings.apiKey("mistral")` and
   pushes a copy to the remote host's own `secrets.json`.
3. **Agent shows `paused` in Project Tracker** — it detected `qm`/`pvesh` or
   `proxmox-mcp` itself unreachable; check `systemctl status proxmox-mcp
   jarvisd-proxmox-agent` on the host.
4. **A VM never gets tuned despite being congested** — check
   `proxmox_get_blocklist`, then the per-VM `last_action_at` (cooldown), then
   whether the host has headroom left (`reserve_cores`/`reserve_mem_mb` may
   be too conservative for a busy host).
5. **`pending_restart` stays true after you restarted the VM** — it
   self-clears on the agent's next tuning decision for that VM, not
   immediately on restart (not worth a second remote round-trip just to flip
   a flag a few minutes early — see the comment in `handleProxmoxRestartVm`).
6. **`deploy proxmox-mcp` fails with "could not read Username for
   'https://github.com'"** — the repo is private and no `github` API key is
   configured locally (see "Bringing it up" step 2).
7. **jarvisd crash-loops with `GLIBC_2.4x not found` from the AppImage's own
   bundled libs** — the CI box (Fedora, glibc 2.43) bundles distro libs newer
   than the Proxmox host's Debian glibc (2.41 on trixie). The jarvisd binary
   and the Qt libs themselves only need ≤2.38 — it's the linuxdeploy-swept
   extras (glib, libssh, libcrypt, samba/ffmpeg pile) that are too new. Fix
   applied on pve (2026-07-09): move every bundled lib whose max GLIBC
   requirement exceeds the host's out of `squashfs-root/usr/lib/` (system
   copies get used instead), keep bundled `libsasl2.so.3` (Debian's soname is
   `.so.2`) with a `libcrypt.so.2 → /lib/x86_64-linux-gnu/libcrypt.so.1`
   symlink, and quarantine the whole bundled glib family together (a half
   bundled/half system glib mix aborts with `undefined symbol:
   g_string_copy`). The real fix is pinning the CI AppImage build to an older
   baseline image.
