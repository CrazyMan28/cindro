# Phone — native call / text subsystem

Jarvis can reach you on your **real phone**: in-app voice calls, real PSTN calls + SMS
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

## How it's wired into Jarvis
- **Service:** `phone/server` runs on `:8801` (loopback + tailnet). Build with
  `cd phone/server && npm install && npm run build`; run `node dist/main.js`. Its 168 tests
  pass (`npm test`, hermetic). A systemd user unit ships in `packaging/` so it starts with
  the rest of Jarvis.
- **Config / secrets:** reads a Jarvis-managed env at `~/.config/jarvis/phone.env`
  (gitignored, 0600; `AGENT_PHONE_ENV_FILE` points the server at it) — Twilio + Mistral
  creds, DB at `~/.local/share/jarvis/phone.sqlite`. Never in git.
- **Brain access:** `ControlServer::seedPhoneMcp()` reads the phone env and seeds an enabled,
  **high-risk** `phone` MCP server row into `McpRegistry`, so the co-work brain (codex/claude)
  gets all phone tools through the normal MCP injection — `call_user`, `notify_user`,
  `twilio_call_and_wait`, `device_sms`, screening, war room, voice profiles, … The co-work
  system prompt documents when to call vs. text.
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

The entire agent-phone app UI is ported into Jarvis as a first-class **Phone section** —
no separate app. The Phone section has its own five-tab nav:
**Calls · Inbox · Agents · HUD · Settings** — and each surface renders it natively:

### Desktop (QML)
A full-page `PhonePage.qml` added to the sidebar's nav. Tabs load as child pages inside the
Phone section; the rest of Jarvis's nav remains accessible.

### Android (Compose, v0.10.6+)
A dedicated **Phone** destination in the bottom nav. When the user enters the Phone section
Jarvis's main bottom nav is **hidden** (full-screen immersive), replaced by the Phone
section's own five-tab bar. Backing out of Phone restores the main nav.

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
A real outbound **voice call** was placed to the user's phone via Twilio + Mistral TTS and
**answered** (Twilio SID `CA7ea2…`). Outbound **SMS** via the toll-free number returns a
Twilio SID but carrier delivery for *unverified toll-free* is gated by A2P rules (the 2019
law) — use the voice path or complete toll-free verification for guaranteed SMS. Set the
destination once with `twilio_set_user_number(<your cell>)`.

## Notes
- A PSTN voice call needs Twilio's webhook to reach the placing instance — the Tailscale
  funnel's `/twilio` path must point at this server's port.
- On-device desktop voice still uses Jarvis's own Voxtral; a phone *line* uses the server
  Mistral voice (a PSTN line can't run the on-device voice).
- The `phone.http` proxy keeps the admin bearer token exclusively inside `jarvisd` — UI
  surfaces never hold the server credential.
