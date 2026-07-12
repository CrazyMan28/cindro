# Phone — native call / text subsystem

Orin can reach you on your **real phone**: in-app voice calls, real PSTN calls + SMS
(Twilio), free SMS off the phone's own SIM, an in-app inbox, AI call screening, a war
room, voice profiles — everything a registered phone agent does, **packaged into the one
repo** (no second repo for end users).

## What it is
The proven **agent-phone** server (Fastify + better-sqlite3 + `ws` + Mistral STT/TTS +
Twilio) is **vendored verbatim** into `phone/server` — byte-for-byte identical to its
source (86 `.ts` files, ~16k lines; `diff -rq` of the trees is empty). It is the source of
truth for behavior; its docs were stale so this was copied from **code**. A complete
feature inventory (55 MCP tools, 78 HTTP routes, 21+45 WS events, all feature areas,
13 undocumented features incl. `device_sms`) is in
[AGENT_PHONE_FEATURE_MAP.md](AGENT_PHONE_FEATURE_MAP.md).

The **original agent-phone repo is untouched and continues to run separately** — the
vendored copy in `phone/server` is a byte-identical snapshot; changes go back upstream if
needed, not hand-edited here.

## Extension assignments on the phone server

| Extension | Identity |
|-----------|----------|
| 100 | Primary user (human) |
| **101** | **Jarvis** (this system) |
| 102 | Codex |
| 103 | Copilot |
| 104 | Echo |
| 105 | Hermes |
| 106 | Claude |
| 107 | Mistral Screener |

## How it's wired into Orin
- **Service:** `phone/server` runs on `:8801` (loopback + tailnet). Build with
  `cd phone/server && npm install && npm run build`; run `node dist/main.js`. Its 168 tests
  pass (`npm test`, hermetic). A systemd user unit ships in `packaging/` so it starts with
  the rest of Orin.
- **Config / secrets:** reads an Orin-managed env at `~/.config/jarvis/phone.env`
  (gitignored, 0600; `AGENT_PHONE_ENV_FILE` points the server at it) — Twilio + Mistral
  creds, DB at `~/.local/share/jarvis/phone.sqlite`. Never in git.
- **Brain access (tools live ON computer-use):** the brain runs **isolated** (codex
  `--ignore-user-config`, claude `--strict-mcp-config`), so it only sees the built-in
  **computer-use** MCP — a separate `phone` HTTP server registered in `McpRegistry` is
  **never reached by codex**. So the phone tools are registered directly on the computer-use
  engine in `computer-use/computer_use_mcp/tools_phone.py`, each proxying to jarvisd's
  **`phone.mcp`** method (which holds the phone bearer): **26 explicit** tools — `call_user`,
  `call_user_and_wait`, `twilio_call_and_wait`, `device_sms`, `twilio_sms`, `notify_user`/
  `_and_wait`, screening, allowlist, voice profiles, group/inbox, `red_alert`, … — **plus a
  generic `phone_tool(name, arguments_json)`** escape hatch for the rest of the ~56. This keeps
  codex's own CLI MCP servers off-by-default while still letting Orin call/text the user. A
  builtin **`/phone` skill** (`ControlServer::seedPhoneSkill()`) is the full playbook;
  `internal_docs` (v3) covers it too. (`seedPhoneMcp()` still seeds a `phone` registry row that
  the desktop/app/Chrome surfaces drive via `phone.mcp`/`phone.http`, but the BRAIN gets its
  tools through computer-use.)

## Inbound — Orin wakes up and answers when you call or text
Jarvis is **extension 101**, registered as both the **inbound call agent** and the **SMS
agent** on the phone server. When the user calls or texts the Twilio number:
- The phone server's `AgentRunner` **spawns Orin's brain adapter headlessly** (no app/UI
  needed) — `phone/server/src/adapters/codex-bridge.mjs`, full-access — and bridges the
  conversation: **voice** on a call (Mistral STT → brain → TTS), a **text reply** on an SMS.
- The adapter hands the brain the outbound tools mid-conversation, so Orin can **call or
  text the user back** while talking to them (`phone-call.mjs` / `phone-device-sms.mjs` / …).
- Unknown callers are **screened first** (read-only, talk-only) before reaching Orin.
- Inbound SMS routing is on by default (`POST /api/sms-agent {enabled:true, extension:"101"}`);
  replies go out free via the **device SIM** (`device_sms`) since Twilio toll-free SMS is
  A2P-gated.
- **MCP proxy (every surface):** Contract A method **`phone.mcp`** (`{name, arguments}` →
  `{data|text, tool, error?}`) proxies a tool call to the phone server while keeping the
  bearer inside the daemon. Desktop / Android / Chrome drive all 55 tools over their existing
  connection with no token handling. Exposed on the control **and** device surfaces.
- **REST proxy (every surface):** Contract A method **`phone.http`** (`{method, path, body?}` →
  `{status, data}`) forwards arbitrary HTTP requests to the phone server's REST API, again with
  the bearer kept in the daemon. The UI surfaces use this for everything the MCP tools don't
  cover — per-agent configuration, live call list, voice catalog, screening rules, SMS agent
  setting:

  | Route | Purpose |
  |-------|---------|
  | `GET/PATCH /api/extensions/<ext>/voice` | Per-agent voice + emotions + preview + speaking-rate |
  | `GET/PATCH /api/extensions/<ext>/model` | Per-agent LLM model + thinking toggle |
  | `GET/PATCH /api/screening` | Call screening + carrier forwarding rules |
  | `GET/PATCH /api/sms-agent` | Which agent handles inbound SMS |
  | `GET /api/voices` | Full voice catalog (for pickers) |
  | `GET /api/calls` | Live + historical call list |

## Full-screen Phone UI (all three surfaces)

The entire agent-phone app UI is ported into Orin as a first-class **Phone section** —
no separate app. The Phone section has its own five-tab nav:
**Calls · Inbox · Agents · HUD · Settings** — and each surface renders it natively:

### Desktop (QML)
A full-page `PhonePage.qml` added to the sidebar's nav. Tabs load as child pages inside the
Phone section; the rest of Orin's nav remains accessible.

### Android (Compose, v0.11.0+) — the original app, vendored verbatim
The **entire original agent-phone Android app** is copied **byte-for-byte** into the one
Orin APK — all 60 files / ~11,882 lines, package `com.agentphone.*`, nothing
reimplemented or removed. The Orin **Phone tab** (`ui/phone/PhoneLaunchScreen.kt`) launches
the real `com.agentphone.MainActivity` → `AppRoot()`, so the user gets the exact original
look, flow, and **every** screen/setting/button: Calls · Inbox · Agents · HUD · Settings, the
setup wizard, agent config, call screening, SMS agent, diagnostics, history, enroll, relay
puck, and the incoming/outgoing/screening call activities + services. Only the wiring is
Orin's: the manifest registers the vendored activities/services (`MainActivity` non-launcher),
the on-device TTS uses the bundled sherpa-onnx AAR, and the app's server URL defaults to
**Orin's phone server (`:8801`)**, not the original (`:8799`).

### Chrome extension (MV3)
A **Phone** panel added to the side-panel router, using the same five-tab layout adapted
for the extension's width constraints.

### Feature areas inside the Phone section

| Tab | Features |
|-----|---------|
| **Calls** | Real dialpad (12-key + `*`/`#`) with extension-chip shortcuts for enrolled agents; live call state (ringing → active → ended); call history |
| **Inbox** | In-app message threads; **New Chat** flow: multi-agent picker, optional first message, **Start** (text) or **Call** button |
| **Agents** | Per-agent config: voice picker + emotion sliders + TTS preview, speaking-rate, LLM model, thinking toggle; enroll / unenroll |
| **HUD** | Live call HUD (transcription, agent state machine, mute/hold); diagnostics; Bluetooth relay puck (relay `/relay/media` WS) |
| **Settings** | Call screening rules + carrier forwarding toggle; SMS agent assignment; setup wizard; history; diagnostics |

## Real-world verification
Inbound PSTN calls reach Orin and converse (verified). An **in-app VOIP call** to the
user's device was placed (`call_user`) and **rang the app — the user answered** (the call
went `ringing → accepted → active`, transcript `100/user: "Hello?"`).

**Two real-world gotchas, both important:**
- **The device must be ONLINE** for in-app calls to ring it. The agent-phone foreground
  service holds that device WS; Orin's `MainActivity` now starts it on every app launch
  (not just the Phone tab), so ext 100 stays connected in the background. If the device is
  offline, in-app calls are marked `missed/target_offline`.
- **Outbound real-phone calls** come from the **toll-free** Twilio number, which carriers
  readily **spam-filter to voicemail** (a 265s call with zero transcripts = voicemail). The
  account is also a **Trial** (a "press a key" preamble; outbound only to *verified* numbers
  — manage at `/Accounts/<SID>/OutgoingCallerIds`). For a reliable PSTN ring: save the number
  in contacts + disable carrier spam filtering, and upgrade Twilio out of trial. Otherwise
  **prefer the in-app path** (keep the device online). Outbound **SMS** via the toll-free
  number is A2P-gated (the 2019 law) — prefer `device_sms`. Set the destination once with
  `twilio_set_user_number(<your cell>)`.

## Notes
- A PSTN voice call needs Twilio's webhook to reach **this** server — the Tailscale funnel's
  `/twilio` path is pointed at **Orin's `:8801`** (real route `/twilio/voice`), so inbound
  calls/texts to the number are answered by Jarvis (ext 101), not the original `:8799`. Repoint
  with `tailscale funnel --bg --https=443 --set-path=/twilio http://127.0.0.1:8801/twilio`;
  the server's `TWILIO_PUBLIC_BASE_URL` must equal the funnel host for signature validation.
- On-device desktop voice still uses Orin's own Voxtral; a phone *line* uses the server
  Mistral voice (a PSTN line can't run the on-device voice).
- **Custom cloned voice on calls:** set `MISTRAL_TTS_REF_AUDIO_FILE` in `phone.env` to a
  reference clip (e.g. `~/.config/jarvis/voices/jarvice_ref.mp3`, the same clip the desktop
  uses). The server then sends it as `ref_audio` (zero-shot clone) on every TTS, which
  REPLACES the named `MISTRAL_TTS_VOICE_ID`. Mistral's `/audio/speech` rejects a `speed`
  field (HTTP 422) — never send it; that bug made every call silent.
- **Carrier call-forwarding** (forward your own cell to the agent) is carrier-specific:
  Verizon/"5G UW" needs `*71<num>` (missed/declined) / `*72<num>` (all) / `*73` (off), NOT
  the GSM `**` codes. The Android Call-screening card spells this out. Not needed to *call*
  the number directly.
- The `phone.http` proxy keeps the admin bearer token exclusively inside `jarvisd` — UI
  surfaces never hold the server credential.
