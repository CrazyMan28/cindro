# laterfoxes.md — deferred fixes from the 2026-07-11 cross-surface review

These findings are **real but were intentionally not fixed** in the hardening
wave (PR #102). Each needs a decision, infrastructure, or hardware that is
beyond a mechanical code change — so they're parked here with enough detail to
pick up later. Listed worst-first.

The other three deferred findings (#4 shared-engine session disambiguation,
#5 session-less `file.push` broadcast scope, #7 extension dead phone-connection
UI) have implementation plans and are being handled separately — they are NOT
in this doc.

---

## 1. Device "biometric tier" is never enforced server-side — CRITICAL

**What:** The phone/device channel advertises capability tiers (read / action /
biometric) via `DeviceServer::tierFor()` / `capabilityMap()`, but
`dispatchAuthed()` never re-checks the tier before executing. The biometric gate
is enforced only in the phone UI *before* a request is sent.

**Risk:** Anything holding the ed25519 device key (a modified or hostile paired
client) can invoke biometric-tier methods — `auth.approve`, `settings.set`,
`mcp.add`, take-over — with no biometric at all.

**Already partially addressed:** the concrete forgery sub-issue (guessable
`takeover-<sid>` / `inject-<sid>` approval ids) WAS fixed in PR #102 via a
random, registry-tracked, TTL'd approval id. This item is the broader "server
never checks tier at all."

**What a real fix requires (decision needed):** a version-negotiated protocol
change. Provision a separate Android Keystore key with
`setUserAuthenticationRequired(true)`; for `tierFor(method) == "biometric"` the
client signs `(method, params-hash, nonce, timestamp)` with it; `dispatchAuthed()`
consults `tierFor()` and rejects biometric-tier requests lacking a fresh,
replay-protected signature. Needs replay-window / clock-skew / API-level review
and an old-client fallback + re-pair path. **Blocked on:** product sign-off +
coordinated C++/Kotlin protocol work.

**Files:** `daemon/src/DeviceServer.cpp` (`dispatchAuthed`, `tierFor`),
`android/.../net/DeviceClient.kt`, device-identity/keystore code.

---

## 2. Self-update trusts a downloaded binary on magic-bytes + size only — HIGH

**What:** `Updater::releaseApply` validates the downloaded release asset with only
a 4-byte magic (MZ/ELF) and a ≥1MB size floor — no checksum, no signature — then
atomically self-replaces the daemon/AppImage (or runs the Windows installer).

**Risk:** a compromised GitHub release or build pipeline = silent RCE whenever
`auto_update_apply` is on. The periodic update check is default-on. Stark
asymmetry with `PluginSigner`'s ed25519 verification for plugins — the
higher-privilege path has the weaker check.

**What a real fix requires (decision needed):** verify the asset against a
signature before the self-replace, fail closed on mismatch, keep the `.old`
rollback. Options: minisign/cosign with a public key pinned in the binary, or a
signed checksums manifest. A bare "SHA-256 in the release notes" is near-useless
(whoever can publish the malicious asset can publish a matching digest).
**Blocked on:** a code-signing / key-distribution decision (where the private key
lives, how CI signs releases, where the public key is pinned) — infra, not code.

**Files:** `core/src/Updater.cpp` (`releaseApply` ~ magic/size check),
release CI workflows, `packaging/`.

---

## 3. Windows reverse-tunnel rendezvous pairing is unauthenticated — HIGH

**What:** the reverse-tunnel rendezvous binds `AnyIPv4` with a wildcard
(`profile=any`) firewall rule and FIFO-pairs whatever connects first, with zero
identity check.

**Risk:** an attacker who reaches the rendezvous port and beats the ~2-minute
in-sandbox dialer wins the pairing race and gets the daemon's bearer-authed
video/MCP stream of the agent's activity spliced to itself.

**Mitigating context:** inert unless the operator opts into the experimental
`JARVIS_ENABLE_V2` (off by default).

**What a real fix requires:** add a per-session shared secret (reuse/derive from
AgentDesktop's per-session bearer) to the rendezvous handshake —
`onRendezvousConnection` buffers and **constant-time-compares** N token bytes
(with a short timeout) before promoting a socket into `m_idleTunnels`, so no
token bytes leak into `SocketBridge`; `TunnelDialer` writes the token first;
thread it through `relay_main.cpp --token`, `bootstrap.ps1`, and
`jarvis-agent.wsb.in`. **windows/ only** (must not touch shared dirs).
**Blocked on:** exact wire-framing design across 5 files/2 languages AND
validation on real Windows Pro/Ent hardware with Windows Sandbox — can't be
exercised on the current box.

**Files:** `windows/isolation/relay/ReverseTunnel.cpp`, `relay_main.cpp`,
`windows/isolation/sandbox/bootstrap.ps1`, `jarvis-agent.wsb.in`, `TunnelDialer`.

---

## 6. Windows v2 sandbox teardown may orphan the VM — LOW

**What:** teardown calls `killProc(d.sway)` assuming that also tears down
`WindowsSandbox.exe`; this is an unverified assumption (a Job Object bound to the
process likely won't capture a service-spawned VM worker like `vmwp.exe`).

**Risk:** on an abnormal exit a live isolated desktop VM could be left running.

**Mitigating context:** off-by-default experimental tier (`JARVIS_ENABLE_V2`);
teardown already severs host-side reachability (tunnel + firewall) independent of
VM death, and the next `ensure()` degrades to `sandbox_busy`. `sweepOrphans()`
deliberately refuses to `taskkill` an ambiguous `WindowsSandbox.exe`.

**What a real fix requires (additive, but needs hardware):** after
`killProc(d.sway)`, reuse the `sandboxAlreadyRunning()` tasklist probe as a
post-condition and log/surface a warning if a `WindowsSandbox*` process survives;
before shipping non-experimentally, validate on real hardware whether an
unanswered `WM_CLOSE` confirmation dialog orphans `vmwp.exe` and, if so, find the
programmatic close signal. **Blocked on:** real Windows Pro/Ent hardware.

**Files:** `windows/shell/AgentDesktop.cpp` (`killProc` / teardown / `sweepOrphans`).

---

### Summary of what unblocks each

| # | Severity | Blocked on |
|---|----------|-----------|
| 1 | critical | product sign-off + versioned C++/Kotlin protocol change |
| 2 | high | code-signing key + CI signing infrastructure decision |
| 3 | high | wire-framing design + real Windows hardware validation |
| 6 | low | real Windows hardware validation |
