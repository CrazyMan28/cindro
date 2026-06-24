# Jarvis — Google connectors (Calendar / Docs / Drive / Gmail)

Status: **framework ready, needs YOUR Google OAuth credentials to activate.**

Jarvis reaches Google services the same way it reaches any tool: as **MCP servers**
the brain can call. Because the now-default isolation strips the CLI's own MCP
servers, you add Google as **Jarvis** MCP servers (Settings → MCP → paste config,
or the CLI-toggle list), and they're injected — with auth — into both brains.

## Why this needs you (honest limitation)
A Google connector needs an **OAuth app** (client id + secret + consented scopes)
that only the account owner can create — I can't make a Google Cloud project on your
behalf. Once you have creds, wiring it into Jarvis is one paste / one script.

## One-time: create the OAuth app (5 min)
1. https://console.cloud.google.com → new project "Jarvis".
2. **APIs & Services → Enable APIs**: Google Calendar API, Drive API, Docs API,
   Gmail API (enable the ones you want).
3. **OAuth consent screen** → External → add yourself as a test user; scopes:
   `calendar.readonly` / `calendar.events`, `drive.readonly`, `documents.readonly`,
   `gmail.readonly` / `gmail.send` (pick per service; least-privilege first).
4. **Credentials → Create OAuth client ID → Desktop app**. Save the client id +
   secret (and download the JSON).

## Wire it into Jarvis (pick one)
**A. A Google MCP server (recommended).** Use an MCP server that speaks Google APIs
(several community ones exist, typically run via `npx`). In Jarvis → **MCP → Add /
Paste config**, add it as a **stdio** server, passing your creds via env, e.g.:
```json
{ "mcpServers": { "google-calendar": {
    "command": "npx",
    "args": ["-y", "<google-mcp-server-package>"],
    "env": { "GOOGLE_OAUTH_CLIENT_ID": "...", "GOOGLE_OAUTH_CLIENT_SECRET": "...",
             "GOOGLE_OAUTH_REFRESH_TOKEN": "..." } } } }
```
The first run does the OAuth consent in your browser and caches a refresh token.
Once enabled it's injected into codex + claude (isolated), so you can say
"what's on my calendar tomorrow" / "summarize this Google Doc".

**B. Tokens as secrets.** Keep the client secret / refresh token in Jarvis's secret
store (`~/.config/jarvis/secrets.json`, 0600) — NEVER in git. The MCP `token`/`env`
fields reference them.

## Suggested first connector: Calendar
Calendar is read-mostly and feeds the **"today" digest** (skills.today) and Voice
Mode ("what's on my calendar"). Add it first, confirm "what's my next event" works,
then add Drive/Docs/Gmail. Gate **writes** (send email, edit doc) behind the
approval/biometric tier.

## What's already done for you
- The MCP registry + paste-config UI + per-CLI toggle list + isolated injection into
  both brains (so a Google MCP server's tools reach the model securely).
- The secrets store for the OAuth secret/refresh token.
- The "today" digest hook that a Calendar connector plugs into.

→ Give me your OAuth client id/secret (or say you've added the server) and I'll wire
the Calendar connector end-to-end + verify "what's on my calendar" works.

## What's wired now (framework)
The connector framework is implemented end-to-end (no live Google calls yet — you
still bring your own OAuth creds, but the plumbing exists):

- **Control methods** (`ControlServer`, control + device channels):
  - `connectors.add {service, client_id, client_secret, refresh_token}` — `service`
    is one of `calendar|docs|drive|gmail`. Creates a **disabled** stdio MCP server
    row named `google-<service>` whose `endpoint` is the per-service default
    `npx -y <pkg>` command, with risk per the catalog (Gmail/Drive = `high`). Returns
    `{id, name, enabled:false}`. Placeholder/empty creds are accepted (mock).
  - `connectors.list` — returns `{connectors:[{id,name,service,enabled,risk,
    has_client_id,has_client_secret,has_refresh_token}]}`. The `has_*` booleans come
    from the secret store; **raw secret values are NEVER echoed.**
- **Secret-ref env scheme.** The three OAuth creds are stored as **write-only**
  secrets keyed `connector:<id>:client_id|client_secret|refresh_token` in
  `~/.config/jarvis/secrets.json` (0600). The MCP row's new `env` column holds a
  JSON map `{GOOGLE_OAUTH_CLIENT_ID: "secret:connector:<id>:client_id", ...}` —
  i.e. **references**, not plaintext (no double-persisting). The daemon resolves
  `secret:<key>` references through `SettingsStore` at injection time and emits the
  resolved env into both brains (claude: `env` object in `--mcp-config`; codex:
  `mcp_servers.<key>.env.<NAME>=<value>` overrides). `McpServerRow::toJson()` omits
  `env` (it may reference secrets), like `token`.
- **Disabled-by-default mock behavior.** A freshly added connector is **disabled**,
  so env injection never runs and the row does not touch the brains until you
  enable it (Settings → MCP toggle, or `mcp.set_enabled`). Activation is a later
  step once real creds + first-run OAuth consent are done.
- **Digest hook.** `buildTodayDigest()` (skills.today) appends a `## Calendar`
  section **only** when a `google-calendar` connector exists AND is enabled
  (placeholder line today; a live fetch slots in at the same spot). A disabled
  connector adds nothing.
- **Settings → Connectors section.** A new `// CONNECTORS` `SectionCard` lists the
  four Google services with an Added/Enabled badge and an **Add** button that calls
  `bridge.connectorAdd(service, "", "", "")` (placeholder creds for the framework;
  real creds via the paste-config flow / future fields). Bridge: `connectorsList()`
  / `connectorAdd(...)` → `connectorsListed` / `connectorsChanged`.

See [[jarvis-monorepo]] and the broader plan in `docs/JARVIS_VOICE_AND_RENDERER.md`.
