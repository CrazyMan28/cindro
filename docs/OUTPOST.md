# Outpost — Remote Machine Pairing & Control

Outpost pairs a remote Windows/Linux/macOS machine with Jarvis using a
one-line install command; once paired, Jarvis can run shell commands and
grab screenshots on that machine by name. It replaces the old SSH tab's
allow-list + exec console with a dial-out WebSocket relay, so there's no
inbound firewall/NAT change needed on the target and pairing survives the
target roaming networks.

## Bringing up outpost-mcp

Outpost is a standalone MCP service, `outpost-mcp` (port `8798`), that owns
pairing, the per-machine token registry, and the WebSocket relay to paired
agents.

### 1. Build the agent binaries

The Go `outpost-agent` binary is what runs ON the paired machine. It must be
cross-compiled into `outpost-mcp/agent-bin/` before pairing can complete —
`/agent/download/...` returns `404 {"error": "agent_binary_unavailable"}`
until this has been run at least once:

```bash
cd outpost-agent
./build.sh
```

This produces `outpost-agent-{linux,darwin}-{amd64,arm64}` and
`outpost-agent-windows-{amd64,386}.exe` in `../outpost-mcp/agent-bin/`
(`CGO_ENABLED=0`, fully static, no runtime dependency on the target).
Re-run `build.sh` whenever `outpost-agent`'s Go source changes.

### 2. Start outpost-mcp

Either run it directly:

```bash
cd outpost-mcp
uv run outpost-mcp
```

or enable the systemd `--user` unit (`packaging/outpost-mcp.service`):

```bash
mkdir -p ~/.config/systemd/user
cp packaging/outpost-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now outpost-mcp.service
```

On first start it auto-generates an inbound bearer token at
`~/.config/jarvis/outpost_mcp_token` (0600) and prints its path. The
service binds `0.0.0.0:8798` by default (the token is the gate — same
tailnet model as `jarvis-mcp`); `/health` and the one-shot `/pair/*` /
`/agent/download/*` routes are the only endpoints that don't require it.

### 3. Register it as an MCP endpoint

For a Claude Code / Codex session (including a Workflow's fired session,
see below) to call the `outpost_*` tools, outpost-mcp has to be registered
as an available MCP server for that session:

```bash
cd outpost-mcp
./client-setup.sh            # print the ~/.claude.json / ~/.codex/config.toml snippets
./client-setup.sh --apply    # patch both files directly
```

This points the client at `http://<advertise-host>:8798/mcp` with the
bearer read from `outpost_mcp_token`. Without this step the `outpost_*`
tools simply don't exist for that session — there's no fallback or
degraded mode, the tool calls fail as unknown tools.

## Pairing a machine

From a user's perspective, pairing has three steps regardless of which
front end kicks it off:

1. **Start pairing** — click "Pair a machine" on the web dashboard's
   Outpost page, use the `/outpost` popup in the legacy TUI, or call the
   `outpost_pair_start` MCP tool directly. This returns a one-shot,
   **10-minute** bootstrap plus two ready-to-paste one-liners:
   - Linux/macOS: `curl -fsSL http://<host>:8798/pair/<bootstrap_id>/sh | bash`
   - Windows (PowerShell): `irm http://<host>:8798/pair/<bootstrap_id>/ps1 -OutFile ...; & ...`
     (deliberately `irm ... -OutFile` + `&`, never `iwr | iex` — a straight
     pipe-to-`iex` can't self-elevate).
2. **Run the matching one-liner on the target machine.** It downloads the
   right `outpost-agent` binary for that OS/arch, POSTs back to redeem the
   bootstrap, and installs itself to start on its own: a `systemd --user`
   unit on Linux/macOS, or a Scheduled Task running in the **interactive**
   session on Windows (`-LogonType Interactive -RunLevel Highest` — a
   session-0 service would only ever see a blank desktop for screenshots).
3. **The machine registers itself** — the install script's POST to
   `/pair/<id>/complete` creates the machine's registry row and hands back
   its token; the agent then dials `outpost-mcp` over WebSocket and shows
   up as `online`. Poll `outpost_pair_status(bootstrap_id)` (or watch the
   web page, which polls automatically) — status moves
   `pending` → `paired` (or `expired` if the 10 minutes lapse first).

Once paired, the machine appears in `outpost_list_machines`, and exec /
screenshot can target it by name or id from any surface — web, TUI, or an
MCP-calling agent session.

**Re-pairing an already-paired machine is supported and is the upgrade
path** — just run a fresh one-liner on it. The install script stages the
new binary to a temp file and atomically swaps it (a live agent locks the
installed path — the old in-place download failed with
`curl: (23)`/ETXTBSY), stops the previous agent (exact-cmdline `pkill
-xf`, never substring `-f`), and starts the new one in the foreground.
Server-side, `/pair/complete` **replaces** any existing same-name registry
row (and drops its live socket) instead of appending a duplicate that
would shadow the new machine in by-name lookups forever. On Windows the
download is staged *before* the old agent is touched, so a failed download
leaves the old, working agent running rather than an agentless machine.

## Installing capabilities onto a paired machine

`outpost.install_workload` is the first instance of a general pattern:
deploying a whole capability (config, secrets, binaries, a systemd service)
onto a paired machine rather than just running one-off commands on it. It's
built entirely FROM `outpost.exec` — no new agent-side protocol, no new
message type on the WebSocket relay; `ControlServer::writeRemoteFile` writes
files via base64-over-exec (sidesteps shell-quoting the payload entirely,
whatever it is) and the install flow is just a sequence of those plus a
`systemctl enable --now`. See `docs/PROXMOX_WORKLOAD_MANAGER.md` for the
first (and so far only) consumer of this pattern — which as of 2026-07-09
also drives VM scouting, per-VM `JARVIS.md` profiles, agent interview
questions, ask-the-agent tasks, and Pinged watch rules through the same
Outpost page (scout progress, question cards, and rule management all
render per selected machine on desktop/web/TUI).

## MCP tools

| Tool | Signature | Notes |
|---|---|---|
| `outpost_list_machines` | `() -> {machines: [{id, name, os, transport, status, last_seen}]}` | Public rows only — never includes the token hash. |
| `outpost_pair_start` | `(name="", os_hint="") -> {pairing_code, bootstrap_id, expires_at, install_cmd_linux, install_cmd_windows}` | One-shot, 10-minute TTL. |
| `outpost_pair_status` | `(bootstrap_id) -> {status}` (+`machine_id` once paired) | `status` is one of `pending \| paired \| expired \| unknown`. |
| `outpost_exec` | `(machine, cmd, timeout=30.0, shell="auto") -> {ok, exit_code, output, error}` | `shell="auto"` runs PowerShell on Windows, `sh -c` elsewhere. Full trust — no allow-list. |
| `outpost_screenshot` | `(machine) -> {ok, image_base64, width, height, captured_at, error}` | PNG, base64-encoded. |
| `outpost_revoke` | `(machine) -> {ok, revoked}` | Drops the live WS connection and deletes the machine's row/token. |

`machine` accepts either the machine's `name` or its `id` everywhere.

## Security model

- **One-shot, 10-minute pairing codes.** A `bootstrap_id` can be redeemed
  exactly once at `/pair/<id>/complete`; a second attempt (or one after the
  10-minute TTL) is rejected.
- **Per-machine tokens are hashed at rest.** Each paired machine gets its
  own `secrets.token_urlsafe(32)` bearer, returned to it exactly once at
  pairing time; only its SHA-256 hash is persisted in
  `~/.config/jarvis/outpost_machines.json` (0600). Losing that file doesn't
  leak usable tokens.
- **Full-trust exec once paired — no post-pairing command allow-list.**
  This is a deliberate design choice, not an oversight: the old SSH tab's
  allow-list gave a false sense of safety while still letting through
  anything expressible via allowed binaries + shell metacharacters. Outpost
  instead puts all the control at the *pairing* boundary — only pair
  machines you trust an agent to fully control, and use `outpost_revoke`
  the moment that trust should end.
- **Output is capped.** `outpost-agent`'s exec path buffers stdout+stderr
  into a bounded buffer capped at **256 KB** (`maxOutputBytes` in
  `outpost-agent/exec.go`); anything captured beyond the cap is discarded
  and the returned `output` has a trailing marker,
  `...[output truncated, <N> bytes total]`, so callers can tell truncation
  happened and see how much was cut.
- **Channel scoping.** `outpost.*` is explicitly out of scope for the
  phone/device channel — it's reachable from desktop, web, and TUI only.
  A phone-paired device attempting `outpost.*` gets back
  `channel_not_allowed`, even though the same verbs are dispatched for the
  desktop control channel (the daemon's `isOpsMethod()` matches
  `outpost.*` for both channels; the phone channel explicitly rejects it at
  the channel boundary in `DeviceServer::dispatchAuthed`). This narrows the
  blast radius for a feature that can execute on other machines.

## Troubleshooting

If pairing or exec isn't working:

1. **Confirm outpost-mcp is actually running:**
   ```bash
   curl http://127.0.0.1:8798/health
   ```
   Expect `{"status": "ok", "service": "outpost-mcp", ...}`. If this fails,
   start the service (see "Bringing up outpost-mcp" above).
2. **Confirm the agent binaries exist:**
   ```bash
   ls outpost-mcp/agent-bin/
   ```
   If empty, `/agent/download/...` will 404 and every install one-liner
   will fail partway through. Run `cd outpost-agent && ./build.sh`.
3. **Check the daemon can reach outpost-mcp.** The daemon proxies
   `outpost.*` verbs to outpost-mcp's loopback REST API on `127.0.0.1:8798`;
   if that port isn't listening, daemon calls fail with
   `outpost_unreachable`.
4. **A paired machine shows `offline`** means its agent isn't currently
   holding a WebSocket to outpost-mcp — check the agent's systemd unit
   (`systemctl --user status outpost-agent`) or Scheduled Task on that
   machine.
