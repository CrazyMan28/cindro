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
- **UI access (every surface):** Contract A method **`phone.mcp`** (`{name, arguments}` →
  `{data|text, tool, error?}`) proxies a tool call to the phone server while keeping the
  bearer inside the daemon. Desktop / Android / Chrome drive all 55 tools over their existing
  connection with no token handling. Exposed on the control **and** device surfaces.

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
