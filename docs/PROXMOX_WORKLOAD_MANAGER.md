# Proxmox Workload Manager — an always-on Cindro agent on the Proxmox host

An always-on agent that lives directly ON a Proxmox host, checks up on VM
resource usage every few minutes, and bumps CPU cores / RAM on congested VMs
within safe limits — **it never restarts, stops, or starts a VM on its own.**
It survives the user's laptop being off (its brain is Mistral via the direct
API, not the Claude Code CLI), keeps its own durable memory of every decision,
and enrolls as a visible agent via Project Tracker so the user's local Cindro
can check in on it and ask for a report.

It is deployed and managed as a first-class Outpost feature — installed onto
a paired machine with one action, surfaced in the desktop GUI, the (Python)
TUI, and the web dashboard, all inside the existing Outpost page.

> **Related:** the [Cindro Proxmox Dashboard](PROXMOX_DASHBOARD.md) is a separate,
> full-power, permission-gated AI dashboard served ON the host (a replacement for
> the Proxmox web UI). It DEPENDS ON this workload manager but is isolated from it:
> a distinct MCP catalog (`:8800` vs this one's `:8799`) so this agent's restricted,
> no-power-tools invariant below is never weakened.

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
- `proxmox_guest_service` (2026-07-09) is NOT an exception: it can
  start/restart/status a **service inside** a guest (regex-validated name,
  closed verb set, argv built in code — the one sanctioned bypass of the
  free-form guest-exec denylist) but has **no `stop` verb and no path to VM
  power whatsoever**. It heals, it can't kill. Mutating verbs are refused
  for blocklisted VMs.

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
     has something to reach for. These live in Cindro's OWN built-in MCP
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
3. **The periodic tick is seeded automatically (2026-07-10).** One
   `schedule.create`/`schedule.update` row (cron `"every 5m"`,
   `targetRef="proxmox-<hostname>"`, a prompt telling the brain to check
   directives, check status, tune what's congested, remember every decision,
   check in with Project Tracker, and never attempt a restart) must exist
   **on pve's own jarvisd**, over ITS OWN loopback control API (`ControlServer`
   is loopback-only by design — see `AGENTS.md`'s Conventions section — so the
   laptop can't call it directly, only `outpost.exec` reaches the host at
   all). `outpost.install_workload` now runs `seed_schedule.py` itself via
   `outpost.exec` right on the host (`websockets` is a normal proxmox-mcp
   dependency — no separate pip step), **detached** so it never blocks the
   install RPC. The seeder is an **upsert**: if a `proxmox-*` row already
   exists with an older prompt, it updates the prompt in place
   (`schedule.update`). This is also the documented **upgrade path** for an
   existing install after a proxmox-mcp code change: re-run
   `outpost.install_workload` (idempotent — re-syncs the sparse clone from
   `main` + `pip install`s, so it only picks up code that has MERGED to main
   — this also re-seeds the schedule and re-opens a fresh scout chat). If the
   automatic seed doesn't stick (e.g. jarvisd-proxmox-agent was still starting
   up), the manual fallback still works:
   ```
   /opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/python3 \
     /opt/jarvis-proxmox-agent/src/proxmox-mcp/packaging/seed_schedule.py
   ```
4. **Install also opens a LIVE scout+interview chat (2026-07-10).** Beyond
   the recurring headless tick above, `outpost.install_workload` creates a
   normal, interactive Cindro session — routed at the proxmox-mcp MCP
   endpoint the same way the tick is (`scheduleTargetRef="proxmox-<machine>"`)
   — and sends it a one-time prompt: introduce itself, scout the fleet live
   (reusing whatever the install-time sweep already started), narrate what it
   finds VM by VM, and for any VM with no recorded Purpose, ask directly IN
   THE CHAT (not the async `proxmox_ask_user` mailbox — this is a real,
   synchronous conversation) and save the answer via `proxmox_update_vm_profile`.
   All three UI surfaces (desktop, web, TUI) read `session_id`/`session_title`
   off the `outpost.install_workload` result and navigate the triggering
   client straight there. Best-effort: a failure opening this chat (surfaced
   in the install `note`, not just a daemon log) still leaves a fully working
   install — the recurring tick picks up any interviewing it didn't get to.
   **Gotcha if you touch this code**: the session MUST be created with an
   empty `profile` (→ "coder" default), never `"coworker"` — that would
   default `target` to `"agent"` and spin up a whole nested Sway/Wayland
   compositor + computer-use engine for a session that only ever calls
   proxmox-mcp tools. `createSession`'s `autoComputer` auto-spawn path is
   also gated on `scheduleTargetRef.isEmpty()` for the same reason (a
   scheduled/routed session is headless by definition — this also fixed a
   latent version of the same issue in the pre-existing recurring tick).
5. **Since 2026-07-09 the installer also**: sweeps the running VMs with
   `qm agent <vmid> ping` (4s/VM behind a 35s deadline) and reports "M of N
   running VMs answered a guest-agent ping" in the install note, kicks an
   **initial fleet scout** (detached — watch the Outpost page), and registers
   the machine in the daemon's `proxmox_machines.json` so agent questions and
   fired pinged rules ping your inbox (see below).

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
| `proxmox_scout` | `(vmids=[], full=False) -> results \| {detached}` | 1–3 vmids scan synchronously; fleet/`full=True` runs the detached `proxmox-scout` CLI. Refreshes JARVIS.md profiles. |
| `proxmox_scout_status` | `() -> {scout:{state,done,total,current_vmid,results}}` | Progress of the current/last scan (backed by `scout_status.json`). |
| `proxmox_get_vm_profile` | `(vmid) -> {exists, profile, meta}` | **Read before tuning/working on a VM** — Purpose/Preferences are binding context. |
| `proxmox_update_vm_profile` | `(vmid, section, text) -> {ok}` | User-owned sections only (Purpose/Preferences/Notes); Observed is scout-owned and refused. |
| `proxmox_list_vm_profiles` | `() -> {profiles:[{vmid,has_purpose,stale,...}]}` | Drives re-scout + interview decisions. |
| `proxmox_ask_user` | `(question, vmid=0, options=[]) -> {ok,qid}` | Non-blocking interview question (max 3 pending, deduped) — answered from the Outpost page. |
| `proxmox_get_answers` | `() -> {answers:[...]}` | Consume answers at the start of every tick; write them into profiles. |
| `proxmox_get_tasks` / `proxmox_reply` | `() -> {tasks}` / `(rid, text) -> {ok}` | Asks/tasks from the user's main Cindro (`proxmox.ask_agent`); reply lands back in the user's chat. |
| `proxmox_get_due_pinged` / `proxmox_record_pinged` | `() -> {rules}` / `(rule_id, fired, result="") -> {ok}` | Watch rules due this tick; ALWAYS record, fired or not (that's what stops a daily rule re-firing all day). |
| `proxmox_guest_service` | `(vmid, service, verb) -> exec result` | verb ∈ {start, restart, status} — see the safety invariant above. |

### On the laptop (`computer_use_mcp`, for a plain chat)

| Tool | Signature | Notes |
|---|---|---|
| `proxmox_check_status` | `(machine) -> proxmox.status result` | "Check up on proxmox" → call this + `proxmox_get_report`. |
| `proxmox_get_report` | `(machine) -> proxmox.report result` | Sync-then-recall from the remote memory db into local agent-scoped memory (`agent="proxmox-<hostname>"`), watermarked by the newest `created` already synced. |
| `proxmox_give_direction` | `(machine, text) -> {ok}` | Queues a directive for the next tick. |
| `proxmox_agent_checkin` | `() -> {agents:[...]}` | Liveness via Project Tracker's `agent_list_active`, filtered to `proxmox-*`. |
| `proxmox_scout` / `proxmox_scout_status` | `(machine, vmids?)` / `(machine)` | "Scan my VMs" — kicks the detached fleet scout, then poll status for live per-VM summaries. |
| `proxmox_vm_profile` | `(machine, vmid)` | Read a guest's JARVIS.md. |
| `proxmox_list_questions` / `proxmox_answer_question` | `(machine)` / `(machine, qid, answer)` | The interview flow from chat. |
| `proxmox_ask_agent` | `(machine, text, kind="ask", wait_sec=90)` | **Talk directly to the pve agent**: queues the ask/task, kicks `schedule.run_now` via the host-side `proxmox-agent-kick` helper, then polls for the reply. Timeout → `{pending:true, rid}` (reply lands ≤5 min via the tick). |
| `proxmox_pinged_list` / `proxmox_pinged_add` / `proxmox_pinged_remove` | see docstrings | Manage watch rules from chat. |

These ship inside Cindro's own built-in MCP server — no separate server to
register, no "only visible to Claude Code" gap.

## VM scout, JARVIS.md profiles, questions, tasks & Pinged (2026-07-09)

The agent no longer flies blind about what runs INSIDE the guests — and no
per-VM agent is ever installed. Everything below scans from the pve host:
QEMU VMs through the guest agent Proxmox already talks to (`qm guest exec`,
Linux via `sh`, Windows via PowerShell — one marker-delimited battery per
guest, every section head-capped), LXC containers through `pct exec` (needs
nothing inside the CT). `systemctl` is on the guest-exec denylist, so the
batteries list services from `/sys/fs/cgroup/*/system.slice` — do NOT
"fix" that by weakening the denylist.

**Host is source of truth.** All state lives under
`/var/lib/jarvis-proxmox-agent/` and the laptop only reads/appends over
`outpost.exec` (free text always travels base64; reply lookups
fetch-then-filter daemon-side so caller-supplied ids are never interpolated
into a shell command):

| File | What |
|---|---|
| `vms/<vmid>.md` | The guest's **JARVIS.md profile** — like CLAUDE.md, but for a VM. `## Purpose` + `## Preferences` are USER-owned (filled via the interview flow), `## Observed` is SCOUT-owned (regenerated wholesale each scan; user sections preserved byte-for-byte), `## Notes` is agent-owned. |
| `scout_status.json` | Live fleet-scan progress the Outpost UIs poll at 3s. Doubles as the concurrency lock (pid-liveness + 30-min staleness — a killed runner never wedges scouting). |
| `questions.jsonl` / `answers.jsonl` | Interview mailbox (agent asks, ≤3 pending, deduped; user answers from the Outpost page or chat; agent consumes next tick and writes the answer into the profile). |
| `agent_tasks.jsonl` / `agent_replies.jsonl` | Talk-to-the-agent mailbox: `proxmox.ask_agent` appends + best-effort kicks `proxmox-agent-kick` (loopback `schedule.run_now`) so asks are processed in seconds; replies stay readable until fetched, pruned after 24h. |
| `pinged.json` / `pinged_events.jsonl` | **Pinged watch rules**: `condition` rules (free text, judged by the agent every tick — "the CI runner on VM 104 looks stuck → check up on it and fix it, don't break anything") and `schedule` rules (daily `HH:MM`, dueness decided deterministically in code). Fired events append to a 200-capped log. |

**Scouting runs two ways** (forced by the 60s outpost-exec wall and the
256KB exec output cap): 1–3 vmids synchronously inside the agent's tick via
`proxmox_scout`, or the whole fleet via the `proxmox-scout` console script
launched detached (`setsid … &`) by `proxmox.scout` / `full=True` /
install. Re-scout policy is manual + agent-judged: no profile, `stale`
(>7 days, `profile_stale_days`), or observed workload no longer matching
`proxmox_status`.

**Inbox pings.** The laptop daemon polls each machine in
`proxmox_machines.json` every 5 minutes for new questions + fired pinged
events, dedupes forever via `proxmox_seen_notifications.json`
(`machine:qid|eid` keys, pruned when gone), and notifies through the phone
proxy (`notify_user` → Cindro inbox on every surface). No `phone.env` → the
poll silently skips; the Outpost page still shows everything. Opening the
Outpost page marks what you saw as seen, so you don't get pinged for
questions you already answered.

**Outpost page** (desktop QML / web / TUI): "Scout VMs" button with live
progress ("Scouting… 3/8 — VM 104"), per-VM ✓/✗ result lines, answerable
agent-question cards (option pills + free text), a Pinged card (add/remove
rules, last-checked/fired status, recent fires), and a per-VM "Profile"
viewer. TUI keys: `o` scout, `q` questions, `i` profile, `n` pinged, plus
input commands `answer <qid> <text>` and
`pinged add <name> | <HH:MM or condition> | <action> [| vmid]`.

**Security model** (unchanged in kind): the main Cindro reaches the pve
agent ONLY through MCP tools → daemon Contract-A RPCs (loopback control
socket; the phone/device channel blocks `proxmox.*` outright) → the
token-authed Outpost relay → files on the host. proxmox-mcp itself stays
loopback-only (:8799, bearer-gated) for the co-located jarvisd; no new
listening ports anywhere.

## Config reference (`/etc/jarvis-proxmox-agent/config.toml`)

| Key | Default | Meaning |
|---|---|---|
| `check_interval_minutes` | 5 | Schedule cadence. |
| `cooldown_minutes` | 15 | Minimum gap between two tune actions on the SAME VM. |
| `reserve_cores` / `reserve_mem_mb` | 2 / 4096 | Host headroom never touched. |
| `bump_step_cores` / `bump_step_mem_mb` | 2 / 2048 | Max increase per tune action, regardless of what's requested. |
| `max_cores_per_vm` / `max_mem_mb_per_vm` | 16 / 32768 | Hard per-VM ceiling. |
| `cpu_congested_pct` / `mem_congested_pct` | 85.0 / 90.0 | Congestion thresholds. |
| `max_pending_questions` | 3 | Interview-question queue bound (deduped on vmid+question). |
| `profile_stale_days` | 7 | A profile older than this is a re-scout candidate. |

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
   configured locally (see "Bringing it up" step 2). **This fails FAST
   (well under a second)**, not slow — if clicking Install on desktop felt
   like "nothing happened," you likely hit this and just didn't see the
   result: before 2026-07-10 the outcome only appeared in the exec console
   further down the page, easy to miss on a click that returns instantly.
   Desktop now also shows the result inline, directly on the machine's own
   row, impossible to miss regardless of scroll position.
7. **Scout says "guest agent not responding" for a running VM** — the QEMU
   guest agent isn't installed/running inside that guest
   (`qemu-guest-agent` package on Linux, the QEMU GA service on Windows) or
   the VM's `agent: 1` option is off. The VM still gets tuned from outside;
   it just can't be profiled deeply.
8. **A scout never starts / "already running"** — check
   `/var/lib/jarvis-proxmox-agent/scout_status.json`; the lock only believes
   `running` while `started_at` is <30 min old AND the recorded pid is
   alive, so a killed runner self-heals on the next attempt.
9. **`proxmox_ask_agent` always times out** — the kick helper needs the
   `proxmox-agent-kick` console script (redeploy proxmox-mcp on the host)
   and the seeded schedule row; without either, replies still arrive on the
   next 5-minute tick, just not in seconds.
10. **Questions/pinged never ping the inbox** — the phone subsystem isn't
   set up (`~/.config/jarvis/phone.env` missing) or the machine never made
   it into `proxmox_machines.json` (self-heals on any successful
   `proxmox.status` call — open the Outpost page once).
11. **Install succeeds but no live chat opens** — check the install `note`
   in the response; a failure opening the scout chat is surfaced there
   (e.g. "Couldn't open the live scout chat automatically"), not just a
   daemon log. The install and recurring tick are unaffected either way —
   the tick will interview you over the next few minutes instead.
12. **Install seems to hang for ~45s+** — if you're on an install before
   2026-07-10, check you're not looking at a stale binary: that version's
   live-chat session used `profile="coworker"`, which spins up a whole
   nested desktop + computer-use engine before the install RPC can return.
   Fixed by using an empty profile (defaults to `"coder"`) instead — pull
   `main` and rebuild if you're seeing this.
13. **jarvisd crash-loops with `GLIBC_2.4x not found` from the AppImage's own
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
