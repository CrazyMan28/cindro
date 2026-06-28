# Agent-Phone Feature Map

> **Purpose:** Authoritative source-of-truth for porting agent-phone into Jarvis (desktop app, Android app, Chrome extension) with full feature parity. Derived exclusively from the code and tests — docs in the agent-phone repo are stale and incomplete.
>
> **Source tree:** `/home/kihi2024/projects/mcp/agent_tts-stt/agent-phone/server/src/`

---

## 1. Overview

### Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+, TypeScript, ESM |
| HTTP server | Fastify |
| WebSocket | `ws` library (two separate WSS servers: `/ws` for agents/devices, `/twilio/media` for Twilio PSTN, `/relay/media` for Bluetooth relay) |
| Database | SQLite via `better-sqlite3` |
| STT/TTS | Mistral AI (`/v1/audio/transcriptions` + `/v1/audio/speech`); on-device Piper (sherpa-onnx) for the phone's "local:" voices |
| PSTN | Twilio REST + media streams (8kHz mu-law over WebSocket) |
| Auth | Bearer tokens: admin / device / agent roles; per-agent tokens minted on enrollment |
| Transport | Tailscale-only by default (`TAILSCALE_ONLY=true`); Tailscale Funnel exposes only `/twilio/*` to the public internet |

### Data Model (schema.ts:1–338)

| Table | Purpose |
|-------|---------|
| `users` | Human users (extension 100 = primary user) |
| `devices` | Android/phone clients |
| `extensions` | Every callable entity: owner_type = `user`, `device`, `agent`, or `group` |
| `agents` | AI agents (Codex, Claude, Copilot, Hermes, Mistral Screener, Echo) with heartbeat and capability list |
| `agent_presence` | Live presence snapshot per agent (updated on every heartbeat/connect) |
| `sessions` | Agent work sessions; linked to calls and memory events |
| `session_context` | Ordered event log for a session (transcripts, call summaries, tool results) |
| `calls` | Every in-app or PSTN call; state machine: `created→ringing→accepted→active→listening→transcribing→agent_thinking→speaking→waiting_for_user→ended/failed/timeout/missed/rejected` |
| `call_participants` | Per-call roster with join/leave timestamps |
| `call_audio_tracks` | Metadata for inbound/outbound audio per participant |
| `messages` | Low-level call turn messages (transcripts, agent utterances) linked to a call |
| `transcripts` | STT results per call and speaker |
| `tts_outputs` | TTS synthesis metadata per utterance (model, voice_id, format, bytes) |
| `agent_messages` | In-app inbox messages between agents and device (the "text" channel) with full lifecycle: queued→delivered→read→replied→expired |
| `message_threads` | Thread index (one per conversation; group threads have multiple members) |
| `events` | Internal audit/event bus (fallback_sent, receipt_sent, twilio.sms_sent, etc.) |
| `mcp_tool_calls` | Every MCP tool invocation with args, result, and success flag |
| `terminal_logs` | Terminal command + output snapshots per session |
| `memories` | Key-scoped memory entries (scope: call/session/agent/user/global) with tags and embedding_ref |
| `summaries` | Deterministic call and session summaries |
| `decisions` | Approval resolution record (links approval_id + rationale) |
| `approvals` | Pending/resolved approval requests (action, risk, command, state) |
| `audit_logs` | HTTP + WS auth and admin actions |
| `auth_tokens` | Per-agent enrolled tokens (SHA-256 hash, scopes, revoked_at) |
| `rate_limit_events` | Per-actor route rate-limit sliding window |
| `missed_calls` | Calls that never reached the callee (persisted for the missed-calls API) |
| `notifications` | Queued push-style notifications to extensions |
| `enrollment_bootstrap` | Single-use 24h bash bootstrap packages for agent self-enrollment |
| `phone_allowlist` | Allowlisted real phone numbers for Twilio calls/SMS |
| `twilio_calls` | Per-SID Twilio call records (direction, stream_sid, status) |
| `twilio_sms` | Inbound + outbound Twilio SMS records |
| `twilio_settings` | Key/value store for Twilio runtime config (inbound_extension, screening_enabled, sms_agent_extension, etc.) |

### How a Call Flows End-to-End

**In-app call (agent → user):**
1. Agent invokes `call_user_and_wait` MCP tool
2. `CallService.dial()` creates a `calls` row in state `ringing`
3. Hub broadcasts `incoming_call` to the user's Android extension (100)
4. Android user taps Accept → WS `call_accept` → call moves to `active`
5. Hub calls `AudioGateway.synthesizeForCall()` which streams Mistral TTS chunks (`tts_start / tts_chunk / tts_end`) to the Android app
6. Android app plays the audio, user speaks → app sends `audio_start / audio_chunk / audio_end` WS frames
7. `AudioGateway.endAudio()` assembles PCM, encodes as WAV, sends to Mistral STT
8. STT result is broadcast as `transcript_final` to the agent's extension
9. Agent classifies the response (approved/denied/instruction/received); memory + session context are updated
10. Agent calls `end_call` → `call_end` event to both sides

**PSTN call (Twilio):**
Steps 1–3 are identical via `twilio_call_and_wait`. Twilio places an outbound call; when the user picks up, Twilio opens a WebSocket to `/twilio/media`. `TwilioBridge` connects this to ext 700 (the PSTN pseudo-extension) and the same TTS/STT pipeline runs over 8kHz mu-law instead of PCM16.

**Inbound PSTN call (user dials the Twilio number):**
Twilio POSTs to `/twilio/voice`. If the caller is allowlisted → agent answers directly. If unknown + screening enabled → screening agent answers on the user's behalf; the device shows a live transcript popup with take-over/end buttons.

**Bluetooth relay call:**
A hardware relay device (Bluetooth puck) connects to `/relay/media` with PCM16 audio. Handled by `RelayBridge` (ext 702) — identical pipeline to the Twilio bridge but without mu-law transcoding. Supports screening via the same `ScreeningService`.

---

## 2. Complete MCP Tool Catalog

Auth required: Bearer token with role `admin` or `agent`. Served at `POST /mcp` (authenticated) and `POST /mcp-local` (loopback-only, no auth, used by local Claude/Copilot dev clients).

All 55 tools are logged to `mcp_tool_calls` on every call (success or failure).

| # | Tool name | Key args | Returns | What it does | Source (tools.ts:line) |
|---|-----------|----------|---------|-------------|----------------------|
| 1 | `call_user` | reason, urgency?, session_id?, from_extension? | CallRecord | Dials extension 100 (the primary user); fires `incoming_call` WS event | tools.ts:207 |
| 2 | `call_user_and_wait` | from_extension, to_extension?, reason, say, urgency?, timeout_seconds?, expected_response_type?, fallback_to_text?, fallback_timeout_seconds?, fallback_options?, escalate_to_twilio?, escalate_phone_number? | `{ok, user_transcript, decision, call_id, fallback_*?, escalated?, twilio_call_sid?}` | Full call-wait loop: dials, speaks TTS prompt, waits for STT answer, classifies (approved/denied/instruction/received). On miss/reject/timeout: automatic text fallback to in-app inbox; if fallback times out and `escalate_to_twilio=true`, escalates to real PSTN call | tools.ts:218 |
| 3 | `ask_on_call_and_wait` | call_id, say, timeout_seconds?, expected_response_type? | `{ok, user_transcript, decision, call_id, duration_seconds}` | Follow-up question on an already-active call; synthesizes TTS, waits for next STT | tools.ts:257 |
| 4 | `call_extension` | extension, reason?, urgency?, session_id?, from_extension? | CallRecord | Dial any internal extension (not just user) | tools.ts:303 |
| 5 | `end_call` | call_id, extension?, reason?, summary? | `{ok, call_id, state, summary}` | End a call; sends `call_end` to participants; stores call summary in memory | tools.ts:314 |
| 6 | `send_call_message` | call_id, message, from_extension?, to_extension? | MessageRow or synthesis result | Send text into a live call; synthesizes to audio if the target is a device/user extension | tools.ts:332 |
| 7 | `list_extensions` | — | ExtensionRecord[] | List all extensions with online/busy status | tools.ts:352 |
| 8 | `twilio_call_and_wait` | to_number?, reason, say, from_extension?, urgency?, session_id?, timeout_seconds?, expected_response_type?, fallback_to_sms? | `{ok, user_transcript, decision, twilio_call_sid, phone_number, sms_fallback_sent?}` | Real PSTN outbound call via Twilio; bridges audio through ext 700; speaks TTS, waits for STT; optional SMS fallback if unanswered | tools.ts:357 |
| 9 | `twilio_sms` | to_number?, body, session_id? | `{ok, sid, to_number}` | Send SMS from the Twilio number to an allowlisted number | tools.ts:387 |
| 10 | `device_sms` | to_number, body, session_id? | `{ok, to_number, via: "device_sim"}` | Send SMS from the USER'S OWN PHONE SIM (free, no Twilio). Phone must be online; sends `send_sms` WS event to ext 100 | tools.ts:402 |
| 11 | `twilio_allowlist_add` | phone_number, label? | `{ok, allowlisted}` | Add a real phone number to the Twilio allowlist (E.164 or US 10-digit) | tools.ts:420 |
| 12 | `twilio_allowlist_remove` | phone_number | `{ok, removed}` | Remove a number from the allowlist | tools.ts:429 |
| 13 | `twilio_allowlist_list` | — | `{numbers, default_user_number, inbound_extension}` | List allowlisted numbers + default user number + inbound agent | tools.ts:438 |
| 14 | `twilio_register_inbound_agent` | extension | `{ok, inbound_extension, agent}` | Set which agent extension answers when the user dials the Twilio number | tools.ts:449 |
| 15 | `twilio_set_user_number` | phone_number | `{ok, default_user_number}` | Set (and auto-allowlist) the user's real phone number | tools.ts:462 |
| 16 | `twilio_status` | — | `{configured, from_number, screening_enabled, sms_agent_enabled, bridge, screening, …}` | Full Twilio integration status snapshot | tools.ts:473 |
| 17 | `twilio_screening_enable` | — | `{ok, screening_enabled: true}` | Turn on call screening for unknown callers | tools.ts:485 |
| 18 | `twilio_screening_disable` | — | `{ok, screening_enabled: false}` | Turn off call screening | tools.ts:495 |
| 19 | `twilio_screening_take_over` | call_id | `{ok, call_id, transport}` | Bridge a screened call to the user's real phone (same as the "Take over" button) | tools.ts:505 |
| 20 | `twilio_screening_end` | call_id | `{ok, call_id}` | Hang up on a screened caller (same as the "End" button) | tools.ts:516 |
| 21 | `list_agents` | — | AgentRecord[] | List all registered agents with status | tools.ts:526 |
| 22 | `get_agent_status` | agent_id | AgentRecord | Get one agent's status by id | tools.ts:531 |
| 23 | `update_agent_status` | agent_id, status, current_task?, session_id? | AgentRecord | Update agent status; broadcasts `agent_status` to ext 100 | tools.ts:539 |
| 24 | `create_session` | agent_id?, repo_path?, task? | SessionRecord | Create an agent work session | tools.ts:551 |
| 25 | `get_session_context` | session_id, limit? | SessionContextEvent[] | Read recent events in a session | tools.ts:561 |
| 26 | `append_session_event` | session_id, event_type, content | SessionContextEvent | Append an event to session context | tools.ts:569 |
| 27 | `search_memory` | query, limit? | MemoryRow[] | Keyword-search all stored memories | tools.ts:578 |
| 28 | `store_memory` | scope, key, content, tags? | MemoryRow | Store a memory entry by scope + key (upsert) | tools.ts:587 |
| 29 | `request_approval` | session_id?, action, risk, command? | ApprovalRow | Create an approval request; sends `approval_request` WS event to ext 100 | tools.ts:597 |
| 30 | `request_approval_by_phone` | from_extension?, session_id?, action, command?, risk, reason, timeout_seconds? | `{ok, approved, decision, user_transcript, approval_id, call_id, via_fallback}` | Full approval flow by phone: creates approval record, calls user, speaks the request, resolves based on spoken yes/no. Missed-call text fallback also resolves the approval if user taps approve/deny | tools.ts:607 |
| 31 | `record_tool_call` | session_id?, tool_name, args?, result?, success | `{id}` | Record an external tool call in the session audit trail | tools.ts:691 |
| 32 | `read_recent_terminal` | session_id, lines? | TerminalLog[] | Read terminal output snapshots for a session | tools.ts:707 |
| 33 | `send_terminal_input` | session_id?, input, adapter_type? | `{sent, requiresApproval?, approval?, reasons?}` | Send terminal input to ext 102 (tmux adapter); dangerous commands intercept → approval request | tools.ts:716 |
| 34 | `notify_user` | to_extension?, title, message, priority?, session_id?, call_id?, thread_id?, from_extension?, subject?, metadata? | `{ok, message_id, thread_id, delivered, queued, status}` | Send an in-app text message; queued if offline, delivered immediately if online | tools.ts:737 |
| 35 | `notify_user_and_wait` | to_extension?, title, message, priority?, options?, timeout_seconds?, session_id?, call_id?, from_extension?, subject?, metadata? | `{ok, replied, timeout, reply_text, selected_option, reply_message_id}` | Send a text message requiring a reply and block until the user replies or timeout | tools.ts:795 |
| 36 | `send_missed_call_fallback` | call_id, to_extension?, reason, original_message, options?, wait?, timeout_seconds?, from_extension?, session_id? | `{ok, message_id, thread_id, delivered, queued, waited, replied, timeout, selected_option}` | Send urgent in-app fallback message after a missed/rejected call so the user can respond by text | tools.ts:859 |
| 37 | `send_call_receipt` | call_id, to_extension?, from_extension?, next_steps?, priority? | `{ok, message_id, thread_id, delivered, summary, tool_call_count, error_count}` | After a call, deliver a structured receipt summarizing transcript, decisions, tool calls, and errors; also stored as a memory entry tagged "receipt" | tools.ts:929 |
| 38 | `get_message` | message_id | `{ok, message}` | Fetch one in-app message by id (with status, response_text, selected_option) | tools.ts:1002 |
| 39 | `get_thread_messages` | thread_id, limit? | `{ok, thread, messages}` | Read all messages in a thread in chronological order | tools.ts:1013 |
| 40 | `list_inbox` | extension?, status?, limit?, since? | `{ok, extension, count, messages}` | List in-app messages for an extension; filter by status (queued/delivered/read/replied/expired) | tools.ts:1027 |
| 41 | `wait_for_message_reply` | message_id, timeout_seconds? | `{ok, replied, timeout, reply_text, selected_option, reply_message_id}` | Block until a message gets a reply or timeout; if already replied, returns immediately | tools.ts:1046 |
| 42 | `send_live_log_drop` | to_extension?, from_extension?, call_id?, session_id?, title, log_text, source?, priority?, metadata? | `{ok, message_id, thread_id, delivered, pushed_in_call}` | Push a live log/output snippet into the inbox AND into the active call surface simultaneously (for streaming progress during a call) | tools.ts:1071 |
| 43 | `summarize_session` | session_id | SummaryRow | Create a deterministic session summary | tools.ts:1128 |
| 44 | `summarize_call` | call_id | SummaryRow | Create a deterministic call summary | tools.ts:1136 |
| 45 | `get_call_summary` | call_id | SummaryRow | Read the latest stored call summary, creating one if needed | tools.ts:1144 |
| 46 | `get_session_calls` | session_id | CallRecord[] | List calls linked to a session | tools.ts:1153 |
| 47 | `get_latest_agent_context` | agent_id | `{session, calls, context}` | Read the latest session context and calls for an agent | tools.ts:1161 |
| 48 | `list_active_calls` | — | CallRecord[] | List ringing and active calls from the database | tools.ts:1173 |
| 49 | `get_call_transcript` | call_id | `{transcripts, messages, summary}` | Read call transcripts, text messages, and summary | tools.ts:1179 |
| 50 | `set_voice_profile` | extension, voice_id?, speed?, name? | `{extension, voice}` | Set a per-extension call voice (Mistral voice UUID or `local:<name>`) and speaking rate (0.5–2.0) | tools.ts:1188 |
| 51 | `get_voice_profile` | extension | `{extension, voice}` | Read an extension's voice profile | tools.ts:1212 |
| 52 | `red_alert` | message, from_extension? | RedAlertResult | WAR ZONE: broadcast alert to every agent, create a group war-room thread; spawn offline agents | tools.ts:1221 |
| 53 | `start_group_chat` | members, message?, subject?, from_extension? | `{ok, threadId, groupId, subject, members, delivered}` | Start a group chat with a subset of agents (text war room) | tools.ts:1229 |
| 54 | `post_group_message` | group_id, body, from_extension? | `{ok, delivered}` | Post into an existing group chat thread, reaching every member | tools.ts:1243 |
| 55 | `get_group_chat` | group_id | `{group_id, messages}` | Read all messages in a group chat / war room | tools.ts:1255 |

---

## 3. HTTP API

Auth scheme: Bearer token in `Authorization` header. Roles: `admin`, `agent`, `device`. Tokens are validated against `ADMIN_TOKEN`, `DEVICE_TOKEN`, `AGENT_TOKEN` env vars or per-agent enrolled tokens stored in `auth_tokens`.

Rate limiting: configurable via `RATE_LIMIT_MAX` (default 120 req) per `RATE_LIMIT_WINDOW` (default 1 minute).

### Core / Setup

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness check: `{ok, service, time}` |
| POST | `/commands/pull` | none | Legacy noop (204) when `ENABLE_LEGACY_COMMANDS_PULL_NOOP=true` |
| GET | `/api/setup/status` | admin/device | Setup health: Mistral key configured, agents registered, etc. |
| POST | `/api/setup/dev-seed` | admin | Seed demo data (disabled in production mode) |
| GET | `/dashboard` | none (token entered in-page) | 2026 cyberpunk ops HUD HTML shell |
| GET | `/static/dashboard.html` | none | Same dashboard (alternate path) |

### Extensions

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/extensions` | any | List all extensions |
| POST | `/api/extensions` | admin | Create an extension |
| GET | `/api/extensions/:extension` | any | Get one extension by number |
| GET | `/api/extensions/:extension/voice` | any | Get per-extension voice profile |
| PUT | `/api/extensions/:extension/voice` | device | Set per-extension voice (voiceId, speed, name) |
| GET | `/api/extensions/:extension/model` | any | Get per-extension AI model + reasoning level |
| PUT | `/api/extensions/:extension/model` | device | Set per-extension AI model + reasoning level |

### Calls

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/dial` | any | Place an internal call |
| POST | `/api/calls/:id/accept` | any | Accept a ringing call |
| POST | `/api/calls/:id/reject` | any | Reject a ringing call |
| POST | `/api/calls/:id/end` | any | End a call |
| GET | `/api/calls` | any | List all calls |
| GET | `/api/calls/:id` | any | Get one call with messages + transcripts |
| GET | `/api/calls/:id/transcript` | any | Get call transcripts + messages |
| GET | `/api/calls/:id/summary` | any | Get call summary |
| GET | `/api/missed-calls` | any | List missed calls (optional `?extension=` filter) |

### Agents

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/agents` | any | List agents (expiring stale heartbeats) |
| POST | `/api/agents/register` | agent/admin | Register an agent |
| POST | `/api/agents/onboard` | agent/admin | Onboard agent (auto-assigns extension) |
| POST | `/api/agents/enroll` | admin/device | Self-service enrollment: mints a per-agent token + bootstrap package |
| GET | `/api/agents/:id` | any | Get one agent |
| POST | `/api/agents/:id/heartbeat` | agent/admin | Update agent heartbeat + status |
| POST | `/api/agents/:id/status` | agent/admin | Update agent status |
| GET | `/api/agents/:id/tokens` | admin | List per-agent tokens (hashes only, no raw tokens) |
| DELETE | `/api/agents/:id/tokens/:tokenId` | admin | Revoke a per-agent token |
| GET | `/api/agents/:id/context` | any | Get latest agent context (sessions + calls) |
| GET | `/enroll/:id/sh` | none (bootstrap ID is the credential) | Single-use bash installer script (24h TTL, consumed on fetch) |
| GET | `/static/connect.mjs` | none | Agent connector source (downloaded by bootstrap installer) |
| GET | `/onboard/device.sh` | none | Device onboarding script (requires ENROLL_TOKEN at runtime) |

### Sessions & Memory

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/sessions` | any | List all sessions |
| POST | `/api/sessions` | any | Create a session |
| GET | `/api/sessions/:id` | any | Get session + last 100 context events |
| GET | `/api/sessions/:id/calls` | any | List calls for a session |
| GET | `/api/sessions/:id/summary` | any | Get session summary |
| POST | `/api/sessions/:id/event` | any | Append event to session context |
| GET | `/api/memory/search` | any | Keyword-search memories (`?q=&limit=`) |
| POST | `/api/memory` | any | Store a memory entry |
| GET | `/api/conversation` | any | Cross-channel merged recent history: texts + call transcripts merged in time order (`?agent=&peer=&limit=`) |

### Approvals & Audit

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/approvals/:id/approve` | any | Approve a pending approval |
| POST | `/api/approvals/:id/deny` | any | Deny a pending approval |
| GET | `/api/audit` | admin | Last 250 audit log entries |

### Messages / Inbox

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/messages` | device | List messages (filter: extension, status, thread_id, limit) |
| GET | `/api/messages/:id` | device | Get one message |
| POST | `/api/messages/:id/read` | device | Mark message read; fires `message_read` WS event |
| POST | `/api/messages/:id/reply` | device | Reply to a message; wakes agent if offline; fires `message_reply` WS event |
| POST | `/api/messages` | device | Send a user→agent message; handles slash commands server-side; spawns agent if offline; routes group threads through war room |
| GET | `/api/message-threads` | device | List threads (filter: extension, status, limit) |
| GET | `/api/message-threads/:id` | device | Get thread with all messages |
| DELETE | `/api/message-threads/:id` | device | Delete a thread |

### Audio

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/audio/stt` | device | HTTP STT: upload base64 PCM/WAV, get transcript |
| POST | `/api/audio/tts` | any | HTTP TTS: get base64 audio for text (formats: pcm/wav/mp3/flac/opus) |
| GET | `/api/mistral-health` | device | Check Mistral voice key + chat key liveness |

### Voices

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/voices` | any | Combined voice catalog: on-device models first, then Mistral voices |
| GET | `/api/voices/:voiceId/sample` | any | Preview audio sample for a Mistral voice (cached in-memory) |
| GET | `/api/local-voices` | any | List on-device Piper voice models (metadata only) |
| GET | `/api/local-voices/espeak-ng-data.zip` | any | Download espeak-ng phoneme data for on-device TTS |
| GET | `/api/local-voices/:voice/:file` | any | Download on-device voice model file (model.onnx, config.json, tokens.txt, sample.mp3) |

### Twilio Screening & SMS Agent

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/screening` | device | Get screening settings (enabled, inbound_extension, screening_extension, transport, agents) |
| POST | `/api/screening` | device | Update screening settings (enabled, inbound_extension, screening_extension, transport: "twilio"/"relay") |
| GET | `/api/sms-agent` | device | Get SMS agent settings (enabled, extension, agents) |
| POST | `/api/sms-agent` | device | Update SMS agent settings (enable/disable two-way SMS routing) |

### War Room / Group

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/red-alert` | device | Trigger red alert (same as MCP tool) |
| POST | `/api/group-chat` | device | Start a group chat |
| POST | `/api/group-chat/:groupId/post` | any | Post to a group chat |
| GET | `/api/group-chat/:groupId` | any | Read group chat messages |
| POST | `/api/conference` | device | Start a multi-party voice conference call |

### Twilio Webhooks (public via Tailscale Funnel)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/twilio/voice` | X-Twilio-Signature | Inbound PSTN call: reject unknown, or accept + open media stream |
| POST | `/twilio/takeover-status` | X-Twilio-Signature | `<Dial>` action callback after a screening take-over |
| POST | `/twilio/status` | X-Twilio-Signature | Call lifecycle status updates (ringing/answered/completed/no-answer) |
| POST | `/twilio/sms` | X-Twilio-Signature | Inbound SMS: mirror to inbox or route to SMS agent |

### MCP Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/mcp/tools` | admin/agent | List all MCP tools |
| POST | `/mcp` | admin/agent | Execute an MCP tool (JSON-RPC 2.0 or flat `{tool, args}`) |
| POST | `/mcp-local` | loopback only | MCP endpoint for local Claude/Copilot dev clients; supports `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized` |

---

## 4. WebSocket Protocol

Endpoint: `wss://…/ws` (path must be exactly `/ws`).

Auth: pass `?token=<bearer>&extension=<ext>` on the URL, or send an `auth` frame after connecting.

### Inbound Events (client → server)

| Event type | Schema | Handled by | Purpose |
|------------|--------|-----------|---------|
| `auth` | `{type, token?, extension, clientType, agentId?, name?}` | hub.ts:627 | Authenticate and bind to an extension |
| `agent_hello` | `{type, token?, agentId, name?, adapterType?, extension?, capabilities[], currentTask?, sessionId?}` | hub.ts:1085 | Agent self-registration + auth in one frame (auto-onboards if first time) |
| `ping` | `{type}` | hub.ts:638 | Keepalive; server responds with `pong` |
| `presence_update` | `{type, extension, online, currentSessionId?, status?, currentTask?}` | hub.ts:829 | Agent updates its own presence and current task |
| `dial` | `{type, fromExtension, toExtension, reason?, urgency?, sessionId?}` | hub.ts:841 | Place an internal call; special: dialing 911 triggers red alert call, dialing a group extension returns an error |
| `call_accept` | `{type, callId, extension?}` | hub.ts:922 | Accept a ringing call |
| `call_reject` | `{type, callId, extension?, reason?}` | hub.ts:950 | Reject a ringing call |
| `call_end` | `{type, callId, extension?, reason?}` | hub.ts:957 | End a call |
| `screening_take_over` | `{type, callId}` | hub.ts:928 | Take over a screened call (device/admin auth required) |
| `screening_end` | `{type, callId}` | hub.ts:928 | End a screened call (device/admin auth required) |
| `call_message` | `{type, callId, fromExtension, toExtension?, content, synthesize?}` | hub.ts:969 | Send text on a live call; if `synthesize=true` (default) and target is a device, routes through per-call TTS speak-chain |
| `audio_start` | `{type, callId, fromExtension, toExtension?, audioFormat?, codec?, sampleRate?, channels?}` | hub.ts:1041 | Begin a spoken turn; sets call state to `listening` |
| `audio_chunk` | `{type, callId, fromExtension, audioBase64}` | hub.ts:1045 | Send a raw audio chunk |
| `audio_end` | `{type, callId, fromExtension?}` | hub.ts:1050 | End a spoken turn; triggers STT → `transcript_final` |
| `memory_query` | `{type, query, limit?}` | hub.ts:1113 | Keyword-search memory; server responds with `memory_result` |
| `approval_response` | `{type, approvalId, decision, response?}` | hub.ts:1120 | Approve or deny a pending approval; broadcasts `approval_response` |
| `agent_status` | `{type, agentId, status, currentTask?, sessionId?}` | hub.ts:1128 | Update agent status; broadcasts `agent_status` |
| `device_message_ack` | `{type, messageId}` | hub.ts:1137 | Mark message delivered; fires `message_updated` to sender |
| `device_message_read` | `{type, messageId}` | hub.ts:1144 | Mark message read; fires `message_read` + `message_updated` |
| `device_message_reply` | `{type, messageId, responseText?, selectedOption?}` | hub.ts:1151 | Reply to a message; resolves any waiting `wait_for_message_reply` |
| `webrtc_offer` | any | hub.ts:698 | Returns `error: webrtc_not_enabled` (WebRTC not implemented in this build) |

### Outbound Events (server → client)

| Event type | Sent to | Fields | Trigger |
|------------|---------|--------|---------|
| `hello` | connecting client | `{type, extension?, role?, protocol, requiresAuth?, supportedEvents[]}` | On connect (unauthenticated) or after auth success |
| `pong` | sender | `{type, time}` | In response to `ping` |
| `error` | sender | `{type, code?, message}` | Any protocol or tool error |
| `incoming_call` | to_extension | `{type, call}` | A call is ringing for this extension |
| `dial_result` | from_extension | `{type, call}` | Call was placed (any outcome) |
| `missed_call` | from_extension | `{type, call}` | Call went to `missed` state |
| `call_accept` | all call participants | `{type, call, conference_roster?}` | Call accepted |
| `call_reject` | all call participants | `{type, call}` | Call rejected |
| `call_end` | all call participants | `{type, call}` | Call ended; includes reason for kicks |
| `call_timeout` | all call participants | `{type, call}` | Call timed out |
| `call_failed` | all call participants | `{type, call}` | Call failed; also sent to calling extension on agent spawn failure |
| `call_state` | all call participants | `{type, callId, state, call}` | Any call state transition |
| `session_update` | all call participants | `{type, callId, state, sessionId}` | On call accept |
| `call_message` | target extension | `{type, callId, fromExtension, toExtension, content, source?}` | Text message sent on a call; also sent for every STT transcript |
| `call_live_log` | call participants | `{type, callId, message}` | Live log drop pushed into an active call |
| `audio_start` | call participants | `{type, callId, fromExtension, audioFormat, sampleRate, channels}` | A spoken turn has started |
| `audio_chunk_ack` | call participants | `{type, callId, fromExtension, bytes}` | Audio chunk received |
| `audio_end` | call participants | `{type, callId, fromExtension, bytes, audioFormat, sampleRate, channels}` | Spoken turn ended, STT complete |
| `audio_error` | target extension | `{type, callId, fromExtension, messageId?, code, message}` | STT failure or mid-call TTS failure; `messageId` scopes to that utterance's buffer |
| `transcript_final` | agent extension | `{type, callId, fromExtension, text, transcript}` | STT result delivered to the agent |
| `transcript_partial` | (reserved) | — | Not emitted in this build; listed in `supportedEvents` for future use |
| `tts_start` | to_extension | `{type, callId, fromExtension, messageId, text, audioFormat, mimeType}` | TTS synthesis started for this utterance |
| `tts_chunk` | to_extension | `{type, callId, fromExtension, messageId, format, audioFormat, mimeType, audioBase64}` | Streaming TTS audio chunk |
| `tts_end` | to_extension | `{type, callId, fromExtension, messageId, bytes, format, audioFormat, mimeType}` | TTS utterance complete |
| `tts_local` | to_extension (device) | `{type, callId, fromExtension, messageId, voiceId, sampleRate, speed, text}` | On-device voice: phone runs sherpa-onnx/Piper locally; no audio streamed from server |
| `agent_status` | broadcast all | `{type, agent}` | Any agent status change |
| `presence_update` | broadcast all | `{type, extension, online, currentSessionId}` | Extension presence changed |
| `approval_request` | ext 100 | `{type, approval}` | New approval request; displayed on device |
| `approval_response` | broadcast all | `{type, approval}` | An approval was resolved |
| `memory_result` | requester | `{type, query, results}` | Response to `memory_query` |
| `message_new` | to_extension (and from_extension) | `{type, message}` | A new in-app message; device flushes queued messages on connect |
| `message_updated` | from_extension | `{type, message}` | Message status changed (delivered, read, replied) |
| `message_read` | from_extension | `{type, message}` | Message was marked read |
| `message_reply` | from_extension | `{type, message, reply}` | User replied to a message |
| `missed_call_fallback` | to_extension | `{type, message}` | Missed-call text fallback delivered |
| `screening_started` | ext 100 | `{type, callId, callSid, callerNumber, forwardedFrom, seq}` | Unknown caller is being screened; show popup |
| `screening_update` | ext 100 | `{type, callId, seq, speaker, speakerExtension, text}` | Live transcript line from screened call |
| `screening_ended` | ext 100 | `{type, callId, seq, reason, outcome}` | Screened call ended or taken over |
| `send_sms` | ext 100 (device) | `{type, number, body}` | Server asks the phone to send an SMS from its own SIM (device_sms tool) |
| `callback_request` | agent extension | `{type, from_extension, to_extension, reason}` | /call slash command: user wants an agent to call them back |
| `red_alert` | each agent + ext 100 | `{type, group_id, from, message, subject, alerted?}` | Red alert broadcast |
| `red_alert_ack` | from_extension | `{type, mode, callId, agents, message}` | Result of dialing 911 (war room call placed) |
| `red_alert_empty` | from_extension | `{type, message}` | No agents could be brought online |
| `war_room_join` | agent extension | `{type, callId, from, subject}` | Agent is told to join a multi-party war room or conference call |
| `conference_roster` | user extension | `{type, callId, members, kicked}` | Updated member list after a voice kick |

### Relay Bridge Protocol (at `/relay/media`)

Client→server (`kind` field):

| kind | Fields | Purpose |
|------|--------|---------|
| `start_call` | `{callerNumber?, forwardedFrom?, screening?, sampleRate?}` | Begin a relay audio session |
| `media` | `{pcmBase64}` | Send a raw PCM16 audio frame |
| `media_end` | — | Force-close current utterance |
| `mark` | `{name}` | TTS playback completed for utterance `name` |
| `takeover` | — | User grabbed the call on their phone |
| `end` | — | End the relay session |

Server→client:

| kind | Fields | Purpose |
|------|--------|---------|
| `media` | `{pcmBase64}` | TTS audio frame for the caller |
| `mark` | `{name}` | Mark sent after last TTS frame |
| `end` | — | Internal call ended; relay should close |

---

## 5. Feature Areas

### 5.1 Calls (In-App)

**What it does:** Real-time voice calls between the user's Android app (ext 100) and any agent extension. Full state machine; supports urgency levels; linked to sessions for memory. Multi-party calls (war room / conference) via group extensions 911/900/902.

**Key files:** `calls/callService.ts`, `calls/conferenceRouting.ts`, `audio/audioGateway.ts`, `websocket/hub.ts`

**Data:** `calls`, `call_participants`, `call_audio_tracks`, `messages`, `transcripts`, `tts_outputs`

**Call states:** `created → ringing → accepted → active → listening → transcribing → agent_thinking → speaking → waiting_for_user` and terminal states: `ended / failed / timeout / missed / rejected`

### 5.2 In-App Messaging / Inbox

**What it does:** Asynchronous text channel between agents and the device. Thread-based (message_threads + agent_messages). Supports priorities (low/normal/urgent/critical), response options (button choices), requires_response flag. Messages are queued when the target is offline and flushed on reconnect. Agents are auto-spawned on incoming texts.

**Key files:** `messaging/messageService.ts`, `routes/http.ts`, `websocket/hub.ts`

**Data:** `agent_messages`, `message_threads`

**Message kinds (in metadata):** notify, notify_and_wait, missed_call_fallback, receipt, log_drop, group_message, slash_reply, agent_unavailable

### 5.3 Twilio PSTN

**What it does:** Real telephone calls and SMS via Twilio. Outbound calls (`twilio_call_and_wait`) stream agent TTS to the caller's phone via mu-law over WebSocket; STT transcribes the caller's voice. Inbound calls from allowlisted numbers ring the configured agent. All calls are linked to the same internal call model so every existing tool (`ask_on_call_and_wait`, `end_call`, etc.) works unchanged on PSTN calls.

**Key files:** `twilio/twilioService.ts`, `twilio/twilioBridge.ts`, `twilio/webhooks.ts`

**Data:** `twilio_calls`, `twilio_sms`, `phone_allowlist`, `twilio_settings`

**Audio codec:** 8kHz mono mu-law → resampled to 16kHz PCM16 for STT pipeline; TTS WAV → resampled to 8kHz mu-law for Twilio.

### 5.4 Call Screening

**What it does:** Unknown callers to the Twilio number are answered by the screening agent while the user's app shows a live transcript popup with "Take over" and "End" buttons. Take-over redirects the Twilio leg via `<Dial>` to the user's real phone number; relay take-over hands audio locally without a Twilio redirect. Two separate agent settings: one for inbound (known callers dialing in), one for screening (unknown callers).

**Key files:** `twilio/screeningService.ts`, `twilio/webhooks.ts`, `relay/relayBridge.ts`

**Transport modes:** `"twilio"` (Twilio PSTN bridge, ext 700) or `"relay"` (Bluetooth puck, ext 702) — switchable at runtime via `POST /api/screening`.

**Loop guard:** After a take-over, a ring-back from the same number within 10 minutes is rejected (prevents carrier-forwarding loops).

### 5.5 War Room

**What it does:** Emergency multi-agent collaboration triggered by dialing 911 or calling the `red_alert` MCP tool. Two modes: TEXT war room (group thread in inbox) and VOICE war room (multi-party call). Spawns all offline agents, creates one shared thread/call, fans out messages to all members. Lead-listens-first policy for voice: named agents get addressed turns, "everyone" fans out, otherwise only the lead responds.

**Key files:** `messaging/warRoom.ts`, `calls/conferenceRouting.ts`, `websocket/hub.ts`

**Special extensions:** 911 (red alert trigger), 900 (broadcast group), 902 (conference group)

**Agent chain cap:** `MAX_AGENT_CHAIN = 4` consecutive agent-authored messages before the chain stops and waits for a real user turn (prevents LLM loops).

### 5.6 Slash Commands

**What it does:** Server-side CLI for the text inbox. Messages starting with `/` are intercepted and handled synchronously before delivery to the LLM agent; the agent "replies" instantly. Unknown commands pass through to the agent's own CLI (e.g. Claude Code `/usage`).

**Commands:** `/phone` (help), `/presence`, `/agents`, `/whoami`, `/voice [show|reset|speed|name|<uuid>]`, `/call [reason]`, `/history [n]`, `/clear`, `/end`, `/group <ext,ext> [msg]`, `/911 [message]`, `/redalert`

**Key files:** `messaging/slashCommands.ts`

### 5.7 Voice Profiles

**What it does:** Per-extension call voice settings: Mistral voice UUID or `local:<name>` for on-device Piper voices, speaking rate (0.5–2.0), display label. Applied every time TTS is synthesized for that extension. Changeable via MCP tools or HTTP API.

**Key files:** `audio/voiceProfiles.ts`, `routes/http.ts`

**Data:** stored as a JSON row in `extensions.metadata` (not a separate table)

### 5.8 Conference Calls

**What it does:** Multi-party voice call with a user-picked subset of agents (vs. red alert which takes all agents). Started via `POST /api/conference`. Same war_room_join mechanism; lead policy and voice kick commands work identically to the 911 war room.

**Key files:** `messaging/warRoom.ts` (`startConference`), `calls/callService.ts` (`createWarRoomCall`)

### 5.9 SMS / device_sms

**What it does (Twilio SMS):** Outbound SMS from the Twilio number via the `twilio_sms` tool. Inbound SMS received at `/twilio/sms` — if "SMS agent" feature is off, mirrored to inbox as a message from ext 700; if on, routed to the selected agent with two-way reply-by-SMS.

**What it does (device_sms):** Sends SMS from the user's own phone SIM — zero cost, no Twilio, no registration. The server sends a `send_sms` WS event to ext 100; the Android app handles it natively. Only works when the phone is connected.

**Key files:** `sms/smsAgent.ts` (outbound hook), `twilio/webhooks.ts` (inbound routing)

### 5.10 Approvals

**What it does:** An agent requests approval for a high-risk action. The user is notified via WS (`approval_request` event) and can respond in the app, by text, or by phone call (`request_approval_by_phone`). Dangerous terminal commands auto-create an approval request without the agent asking. Approval resolution is persisted in `decisions`.

**Key files:** `approvals/approvalService.ts`, `security/dangerousCommands.ts`

**Dangerous command patterns:** sudo, su, recursive force-rm, reboot/shutdown, mkfs, raw dd, risky mount, systemctl stop/restart/disable, firewall changes, user account changes, system-path chmod/chown, git force-push, secrets file access, tailscale funnel, package removal.

### 5.11 Memory

**What it does:** Scoped key-value memory with tag support and an `embedding_ref` column for future vector search. Scopes: call, session, agent, user, global. Auto-summarizes calls and sessions on terminal state. Cross-channel context: call summaries are automatically appended to the linked session context so a subsequent text chat sees what was discussed on a call.

**Key files:** `memory/memoryService.ts`, `memory/eventTypes.ts`

**Data:** `memories`, `sessions`, `session_context`, `summaries`

### 5.12 Missed-Call Fallback

**What it does:** Automatic text fallback when a `call_user_and_wait` fails (user offline, rejected, timeout, TTS failure). Creates an urgent in-app message with action options (approve/deny/call_again/mute_30_min). Optionally waits for a reply. If fallback also times out and `escalate_to_twilio=true`, escalates to a real PSTN call as a last resort.

**Key files:** `mcp/tools.ts` (`withFallback`, `escalateToTwilio`)

### 5.13 Call Receipts / Log Drops

**What it does (receipts):** After a call, `send_call_receipt` delivers a structured post-call summary to the inbox showing: call state, reason, transcript summary, tool calls (count + names), errors, and next steps. Also stored as a `memories` entry tagged "receipt".

**What it does (log drops):** `send_live_log_drop` pushes a text snippet into BOTH the inbox and the active call surface simultaneously, so the user sees streaming progress without the agent needing to speak it.

### 5.14 Allowlist

**What it does:** Whitelist of real phone numbers for Twilio calls and SMS. Outbound calls/SMS to numbers not on the list are blocked at the service layer. Inbound calls from non-allowlisted numbers are either rejected or go to screening. Managed via MCP tools (`twilio_allowlist_add/remove/list`) or auto-populated by `twilio_set_user_number`.

**Data:** `phone_allowlist`

### 5.15 Audio Pipeline / STT / TTS

**What it does (STT):** PCM16 audio (from Android app or resampled from Twilio mu-law / relay PCM) is assembled, converted to WAV, and sent to Mistral's `/v1/audio/transcriptions`. Raw WAVs can be stored for debug via `AUDIO_STORE_RAW`.

**What it does (TTS):** Text is synthesized via Mistral's `/v1/audio/speech` using the per-extension voice profile. Streams in chunks (`tts_start / tts_chunk / tts_end`) to the target extension. On-device voices (local:*) use `tts_local` instead — the phone runs sherpa-onnx/Piper locally; the server only serves the model files.

**VAD (utterance segmenter):** Energy-based VAD at 20ms frame granularity. Start RMS 600, end RMS 300, min 4 speech frames (80ms), 35 silence frames (700ms) to close, 15-frame pre-roll (300ms) to avoid clipping onset, 15s max utterance hard cap.

**Key files:** `audio/audioGateway.ts`, `audio/g711.ts`, `audio/utteranceSegmenter.ts`, `audio/voiceProfiles.ts`, `audio/wav.ts`, `mistral/stt.ts`, `mistral/tts.ts`, `mistral/voices.ts`, `voices/localVoices.ts`

### 5.16 WebRTC

**What it does:** WebRTC offer frames are rejected with `webrtc_not_enabled`. WebRTC is not implemented in this build; audio is sent as push-to-talk WS frames (`audio_start / audio_chunk / audio_end`).

**Key files:** `webrtc/gateway.ts` (stub)

### 5.17 Relay / Bluetooth Bridge

**What it does:** A hardware Bluetooth relay device (puck) can stream a native phone call's audio over WebSocket to `/relay/media` (ext 702 = `RELAY_EXTENSION`). The relay bridge is a near-clone of `TwilioBridge` that accepts PCM16 at any sample rate instead of mu-law at 8kHz. Supports the same call screening pipeline (screening agent answers the caller while the user watches the live transcript). Take-over on relay ends the agent leg; audio continues on the user's phone locally.

**Key files:** `relay/relayBridge.ts`

---

## 6. Undocumented Features

These features are fully implemented in code but missing or incorrect in the project's existing documentation:

| Feature | Detail |
|---------|--------|
| **`device_sms` MCP tool** | Sends SMS from the user's own phone SIM (free, uses carrier), not Twilio. Completely absent from docs. The server sends a `send_sms` WS event to ext 100; the phone's native SMS handler fires. Only works when ext 100 is connected. |
| **Bluetooth relay bridge** | `/relay/media` WebSocket at ext 702 mirrors the full Twilio pipeline for a BT-tethered hardware puck. Docs only mention Twilio. Includes its own screening mode (relay take-over ends agent leg, audio continues natively). |
| **On-device Piper voices (sherpa-onnx)** | `local:<name>` voice IDs route to `tts_local` WS events; the phone synthesizes locally with sherpa-onnx (no Mistral API call). Server only distributes model files via `/api/local-voices/*`. Documented nowhere; `local:jarvis` is the bundled voice name. |
| **`MISTRAL_CHAT_API_KEY` env var** | A separate Mistral API key for the screener's chat inference vs. the TTS/STT key. Checked by `/api/mistral-health` (`chat_key` field). Not documented in `.env.example`. |
| **`/api/conversation` cross-channel memory** | Merges text inbox messages and call transcript messages in a single timeline (`?agent=&peer=&limit=`). Agent connectors load this each turn so the same session context spans both text and voice channels. Not documented. |
| **Enrollment bootstrap system** | `POST /api/agents/enroll` mints a per-agent token + a single-use bash installer package. `GET /enroll/:id/sh` returns a bash script that installs the connector and configures MCP on a remote VM. `GET /onboard/device.sh` does the same for a device. Per-agent tokens are stored as SHA-256 hashes and can be revoked via `DELETE /api/agents/:id/tokens/:tokenId`. |
| **Ops dashboard** | `GET /dashboard` serves a "2026 cyberpunk ops HUD" HTML shell that prompts for a token in-page and calls authenticated `/api/*` endpoints. Not in docs. |
| **`send_live_log_drop` MCP tool** | Pushes a text snippet into BOTH the inbox AND the live call surface simultaneously. Useful for streaming task progress during a call without speaking it aloud. |
| **`request_approval_by_phone` MCP tool** | Full phone-call approval loop: creates an approval record, calls user, resolves it based on spoken yes/no. Missed-call TEXT fallback (if the call is missed) ALSO resolves the approval if the user taps approve/deny — docs only mention the call path. |
| **Screening transport selector** | `POST /api/screening` accepts a `transport: "twilio" | "relay"` field that routes screened calls through the Twilio bridge or the Bluetooth relay bridge. Not documented anywhere. |
| **Agent chain cap** | `MAX_AGENT_CHAIN = 4` (conferenceRouting.ts) is a hard cap on consecutive agent-authored messages in a group thread before the chain stops, preventing token runaway. `AGENT_RELAY_DISABLED=true` env var disables agent-to-agent relay entirely. |
| **PSTN ext 700 / relay ext 702 pseudo-extensions** | These are never stored as real extensions in the DB but are treated as online by registering local sinks in the hub. Any code that calls `isExtensionOnline("700")` will get `true` whenever a Twilio media session is active. |
| **`espeak-ng-data.zip` distribution** | `GET /api/local-voices/espeak-ng-data.zip` serves espeak phoneme data needed by on-device Piper, not documented. |
| **Per-call TTS serialization** | In multi-agent war rooms, the server serializes all TTS requests into a per-call "speak chain" with ~65ms/char hold time, so agents take turns instead of overlapping. This is silent server-side behavior invisible in the API docs. |

---

## 7. UI Surface Requirements

For each feature, what the porting team needs to build on desktop app + Android app + Chrome extension:

### Calls

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Incoming call alert | Modal / notification with Accept + Reject + Ignore | Full-screen incoming call UI (already exists on Android) | Popup notification with Accept/Reject |
| Active call screen | Call duration, current state (listening / agent_thinking / speaking), live transcript feed, mute, end call | Full call screen | Floating call widget |
| Live log drop | Scrollable log area within the call screen | Expandable log section on call screen | Inline log in call widget |
| Missed call fallback | Inline message in inbox with action buttons | Push notification + action buttons in inbox | Badge + popup |
| Call receipt | Styled card in inbox | Styled card in inbox | Badge notification |

### Messaging / Inbox

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Thread list | Sidebar or panel with unread badges | Main screen with swipe | Badge + popup for latest |
| Thread view | Chat-style bubbles; agent messages styled differently | Chat bubbles | Scrollable popup |
| Priority badges | Color-coded borders (low/normal/urgent/critical) | Color-coded notification channels | Color-coded popup border |
| Response options | Buttons rendered from `response_options[]` | Tap-to-reply buttons | Buttons in popup |
| Slash command input | CLI feel: `/` prefix autocomplete | `/` prefix aware input | Single-line input with `/` hint |
| Thread delete | Swipe or button | Long-press or swipe | Not required |

### Twilio / PSTN

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| "Real call" UI | Labeled call screen with phone number visible | Same as in-app call but with phone icon | Floating widget with phone icon |
| SMS compose | Input with send button; addresses to phone numbers | Native-style SMS compose | Popup compose |

### Call Screening

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Screening popup | Slide-in overlay with caller number, live transcript lines, Take Over + End buttons | Persistent notification + full-screen overlay | Popup with transcript + buttons |
| Screening settings | Toggle + agent picker + transport picker | Settings screen toggle | Not required (use desktop or app) |

### War Room / Group Chat

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Red alert trigger | 911 dial shortcut or button | Emergency dial button | Not required |
| Group chat thread | Multi-member thread view; member list sidebar | Group bubble with avatars | Read-only view |
| Conference call | Multi-party call screen; member roster with kick button | Same + speaker indicator | Status widget |

### Voice Profile / Voice Picker

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Voice picker | Dropdown with playable samples | Picker with preview button | Not required |
| Speed slider | Range input 0.5–2.0 | Slider | Not required |
| On-device voice download | Progress indicator for model file download | Download progress + install | Not required |

### Approvals

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Approval request | Modal with action description, risk level, optional command, Approve + Deny buttons | Persistent notification + modal | Popup with Approve/Deny |
| Approval history | Audit log view | Audit log screen | Not required |

### Memory / Sessions

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Session list | Read-only timeline | Read-only view | Not required |
| Memory search | Search input + results list | Search tab | Not required |

### Agent Management

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Agent roster | Table with online/busy/offline status, current task, heartbeat age | Card list | Status sidebar |
| Agent model picker | Dropdown (model + reasoning level) | Picker | Not required |
| Enrollment UI | Form: agent name, adapter type → generates bootstrap URL | Not required (admin-only) | Not required |

### Ops Dashboard

| Surface | Desktop | Android | Extension |
|---------|---------|---------|-----------|
| Cyberpunk HUD | Full ops dashboard: calls, agents, approvals, inbox, Twilio status | Simplified mobile version | Status overview popup |

---

## 8. Config / Secrets Required

All loaded from `.env` (or env vars) via `config.ts:12–78`.

### Core Server

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `SERVER_HOST` | `127.0.0.1` | No | Bind address |
| `SERVER_PORT` | `8799` | No | HTTP/WS port |
| `PUBLIC_BASE_URL` | `http://{host}:{port}` | No | Base URL for self-referencing links |
| `DATABASE_URL` | `file:./agent-phone.sqlite` | No | SQLite file path |
| `PRODUCTION_MODE` | `false` | No | Requires strong tokens, disables dev seed |
| `TAILSCALE_ONLY` | `true` | No | Restrict to Tailscale IPs |
| `LOG_LEVEL` | `info` | No | Fastify log level |
| `RATE_LIMIT_MAX` | `120` | No | Max requests per window |
| `RATE_LIMIT_WINDOW` | `1 minute` | No | Rate limit window |
| `AGENT_HEARTBEAT_TIMEOUT_SECONDS` | `45` | No | Agent heartbeat expiry |

### Auth Tokens

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `ADMIN_TOKEN` | `change-me-admin-token` | **Yes** (rotate in prod) | Admin auth token |
| `DEVICE_TOKEN` | `change-me-device-token` | **Yes** (rotate in prod) | Android app auth token |
| `AGENT_TOKEN` | `change-me-agent-token` | **Yes** (rotate in prod) | Shared agent auth token (individual tokens minted via enrollment) |

### Mistral AI (STT/TTS)

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `MISTRAL_API_KEY` | `""` | **Yes** for real calls | Mistral API key for TTS + STT |
| `MISTRAL_CHAT_API_KEY` | (falls back to MISTRAL_API_KEY) | No | Separate Mistral key for screener chat inference |
| `MISTRAL_STT_MODEL` | `""` (platform default) | No | STT model ID |
| `MISTRAL_TTS_MODEL` | `""` (platform default) | No | TTS model ID |
| `MISTRAL_TTS_VOICE_ID` | `""` | No | Default global TTS voice UUID |
| `MISTRAL_REAL_AUDIO` | `true` | No | `false` = mock mode (no API calls, synthetic responses) |
| `MISTRAL_TIMEOUT_MS` | `60000` | No | API timeout |
| `MISTRAL_MAX_RETRIES` | `3` | No | Retry count on transient errors |
| `MISTRAL_AUDIO_FORMAT` | `mp3` | No | TTS output format (pcm/wav/mp3/flac/opus) |
| `MISTRAL_STT_LANGUAGE` | `en` | No | STT language hint |
| `MISTRAL_TTS_SAMPLE_RATE` | (platform default) | No | TTS sample rate override |
| `DEBUG_AUDIO` | `false` | No | Save raw WAV files to `tmp/calls/<id>/` |
| `AUDIO_STORE_RAW` | `false` | No | Persist raw audio bytes in DB |

### Twilio

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `TWILIO_ACCOUNT_SID` | `""` | **Yes** for PSTN | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | `""` | **Yes** for PSTN | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | `""` | **Yes** for PSTN | Twilio phone number (E.164) |
| `TWILIO_PUBLIC_BASE_URL` | `""` | **Yes** for PSTN | Public HTTPS URL for Twilio webhooks (e.g. Tailscale Funnel URL) |
| `TWILIO_INBOUND_EXTENSION` | `101` | No | Default agent extension for inbound calls from known callers |
| `TWILIO_SCREENING_EXTENSION` | (falls back to inbound) | No | Agent extension for screening unknown callers |
| `TWILIO_VALIDATE_SIGNATURES` | `true` | No | Validate X-Twilio-Signature on webhooks |

### Misc

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_PHONE_ENV_FILE` | `./.env` | Override env file path |
| `AGENT_PHONE_SKIP_DOTENV` | `false` | Skip loading .env (e.g. when env is injected) |
| `ENABLE_LEGACY_COMMANDS_PULL_NOOP` | `false` | Legacy compat noop for old clients polling `/commands/pull` |
| `AGENT_RELAY_DISABLED` | `false` | Kill-switch: prevent any agent from triggering another agent via group chat relay |

### Agents Config (`agents.config.json`)

Per-agent fields (array in `agents` key):

| Field | Purpose |
|-------|---------|
| `extension` | Internal extension number (101–109+) |
| `agentId` | Unique stable ID |
| `name` | Display name |
| `adapterType` | Adapter type: `codex-cli`, `copilot-cli`, `claude-cli`, `mistral-chat`, `stub-echo`, `hermes-cli` |
| `mode` | `stdio` or `stub` |
| `command` / `args` / `cwd` | How to spawn the adapter process |
| `timeoutSeconds` | Per-turn timeout |
| `memoryTags` | Tags auto-applied to this agent's memories |
| `systemPrompt` | Agent's base system prompt |
| `capabilities` | `calls`, `terminal`, `repo-work`, `reasoning`, `tools`, `knowledge`, `test` |
| `env` | Extra env vars for the adapter process |
| `enabled` | Whether the agent runner should manage this agent |

Default agents: Codex (101), Copilot (103), Echo/test (104), Hermes (105), Claude (106), Mistral Screener (107)

---

*Feature map generated 2026-06-28 from source code. Do not rely on agent-phone's own docs — they are incomplete and stale.*
