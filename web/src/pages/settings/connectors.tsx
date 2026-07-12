// SETTINGS · CONNECTORS — Google service connections (connectors.list/add).
// Ported intent from desktop/qml/SettingsPage.qml's "// CONNECTORS" card:
// four known Google services (core/src/Connectors.cpp's catalog — calendar/
// docs/drive/gmail), each launched as a stdio MCP server once real OAuth
// creds are supplied. connectors.list only ever echoes has_client_id/
// has_client_secret/has_refresh_token booleans — the daemon (ControlServer.cpp
// handleConnectorsList) never sends secrets back, so this UI never round-trips
// them either; the three fields below are write-only.
import { createSignal, For, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import { theme } from "../../core/theme"
import { NavIcon } from "../../components/NavIcon"
import type { SettingsSectionDef } from "./index"

interface ConnectorRow {
  id: string
  name: string
  service: string
  enabled: boolean
  risk: string
  has_client_id: boolean
  has_client_secret: boolean
  has_refresh_token: boolean
}

interface CatalogEntry {
  service: string
  label: string
  blurb: string
  risk: string
}

// Mirrors core/src/Connectors.cpp's catalog() 1:1 (service id, display label,
// risk tier) — the daemon has no "connectors.catalog" verb, so the four known
// services are fixed client-side same as SettingsPage.qml's connectorServices.
const CATALOG: CatalogEntry[] = [
  { service: "calendar", label: "Google Calendar", blurb: "Read and write events", risk: "medium" },
  { service: "docs", label: "Google Docs", blurb: "Read and export documents", risk: "medium" },
  { service: "drive", label: "Google Drive", blurb: "Browse and fetch files", risk: "high" },
  { service: "gmail", label: "Gmail", blurb: "Read and send mail", risk: "high" },
]

const HELP_TEXT = `1. console.cloud.google.com -> create a project.
2. APIs & Services -> Library -> ENABLE the APIs you want: Google Calendar, Google Drive, Google Docs, Gmail.
3. APIs & Services -> OAuth consent screen -> External; add your own Google account under "Test users".
4. APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> application type "Desktop app". Copy the Client ID + Client secret.
5. Refresh token: open developers.google.com/oauthplayground -> gear (top right) -> tick "Use your own OAuth credentials" -> paste your Client ID + secret. Pick the scopes for the service, Authorize, then "Exchange authorization code for tokens" and copy the refresh_token.
6. Paste the three values below for that service and tap Connect. Secrets are stored locally and never shown again.
Full guide: docs/JARVIS_GOOGLE_CONNECTORS.md`

function ConnectorsSection() {
  const app = useApp()
  const [rows, setRows] = createSignal<ConnectorRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [showHelp, setShowHelp] = createSignal(false)
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [refreshToken, setRefreshToken] = createSignal("")

  const load = async () => {
    try {
      const res = await app.client.call("connectors.list", {}, 15000)
      setRows((res.connectors ?? []) as ConnectorRow[])
      setError("")
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const rowFor = (service: string) => rows().find((r) => r.service === service)

  const toggleConnect = (service: string) => {
    setClientId("")
    setClientSecret("")
    setRefreshToken("")
    setExpanded(expanded() === service ? null : service)
  }

  const connect = async (entry: CatalogEntry) => {
    setBusy(entry.service)
    try {
      const res = await app.client.call(
        "connectors.add",
        {
          service: entry.service,
          client_id: clientId().trim(),
          client_secret: clientSecret().trim(),
          refresh_token: refreshToken().trim(),
        },
        15000,
      )
      const enabled = Boolean(res.enabled)
      app.notify(enabled ? `${entry.label} connected.` : `${entry.label} added (no creds yet — disabled).`)
      setExpanded(null)
      await load()
    } catch (e) {
      app.notify(`Connect failed: ${String(e)}`, "error")
    } finally {
      setBusy(null)
    }
  }

  // One-click flow: the daemon opens a loopback listener + returns the Google
  // consent URL; we open it, then poll oauth_status until the daemon has caught
  // the redirect and stored the refresh token (no manual OAuth-playground steps).
  const connectGoogle = async (entry: CatalogEntry) => {
    setBusy(entry.service)
    try {
      const res = await app.client.call("connectors.oauth_start", { service: entry.service }, 15000)
      const url = String(res.auth_url || "")
      if (!url) throw new Error("no auth URL returned")
      window.open(url, "_blank", "noopener")
      app.notify(`Opening Google sign-in for ${entry.label}…`)
      const deadline = Date.now() + 5 * 60 * 1000
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        if (Date.now() > deadline) throw new Error("timed out — try again")
        const st = await app.client.call("connectors.oauth_status", { service: entry.service }, 15000)
        if (st.error) throw new Error(String(st.error))
        if (st.connected) break
      }
      app.notify(`${entry.label} connected.`)
      await load()
    } catch (e) {
      app.notify(`Connect failed: ${String(e)}`, "error")
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (entry: CatalogEntry) => {
    setBusy(entry.service)
    try {
      await app.client.call("connectors.remove", { service: entry.service }, 15000)
      app.notify(`${entry.label} disconnected.`)
      await load()
    } catch (e) {
      app.notify(`Disconnect failed: ${String(e)}`, "error")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div class="scn-page">
      <style>{`
        .scn-page { display: flex; flex-direction: column; gap: 14px; max-width: 560px; animation: scn-in var(--dur-slow) ease-out; }
        @keyframes scn-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .scn-title { color: var(--accent); font-size: 11px; }
        .scn-desc { color: var(--text-faint); font-size: 12px; margin: 6px 0 0; line-height: 1.5; }
        .scn-help-toggle {
          all: unset; cursor: pointer; color: var(--accent); font-size: 12px;
          display: flex; align-items: center; gap: 4px;
        }
        .scn-help-body {
          margin: 0; white-space: pre-wrap; font-family: var(--font-mono); font-size: 10.5px;
          line-height: 1.5; color: var(--text-muted); background: var(--surface-deep);
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-sm); padding: 10px 12px;
        }
        .scn-loading { color: var(--text-faint); font-size: 12px; }
        .scn-list { display: flex; flex-direction: column; gap: 10px; }
        .scn-card {
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-sm);
          background: var(--panel-soft); padding: 12px 14px;
          transition: border-color var(--dur-fast) ease;
        }
        .scn-card.on { border-color: var(--accent-dim); }
        .scn-card-row { display: flex; align-items: center; gap: 12px; }
        .scn-card-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .scn-card-label { color: var(--text); font-size: 13.5px; font-weight: 500; }
        .scn-card-blurb { color: var(--text-faint); font-size: 11px; }
        .scn-badge {
          font-family: var(--font-mono); font-size: 10px; padding: 3px 8px; border-radius: 999px;
          border: 1px solid var(--hairline-soft); color: var(--text-muted); white-space: nowrap;
        }
        .scn-badge.on { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-faint); }
        .scn-risk {
          font-family: var(--font-mono); font-size: 9.5px; letter-spacing: var(--track-tight);
          text-transform: uppercase; padding: 3px 7px; border-radius: 6px; white-space: nowrap;
        }
        .scn-risk.medium { color: var(--amber); background: var(--amber-dim); }
        .scn-risk.high { color: var(--danger); background: var(--danger-dim); }
        .scn-connect-btn {
          all: unset; cursor: pointer; white-space: nowrap;
          padding: 6px 14px; border-radius: var(--radius-xs);
          background: var(--accent-dim); color: var(--accent-bright);
          border: 1px solid var(--accent-dim);
          font-family: var(--font-display); letter-spacing: var(--track-mid); font-size: 11px;
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .scn-connect-btn:hover:not(:disabled) { background: var(--accent-faint); }
        .scn-connect-btn:disabled { opacity: 0.45; cursor: default; }
        .scn-form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hairline-faint); }
        .scn-input {
          width: 100%; box-sizing: border-box; background: var(--surface-input);
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
          color: var(--text); padding: 8px 10px; font-family: var(--font-mono); font-size: 12px;
        }
        .scn-input:focus { outline: none; border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-faint); }
        .scn-submit {
          all: unset; cursor: pointer; align-self: flex-end;
          padding: 7px 16px; border-radius: var(--radius-xs);
          background: var(--accent-dim); color: var(--accent-bright);
          border: 1px solid var(--accent-dim);
          font-family: var(--font-display); letter-spacing: var(--track-mid); font-size: 11px;
        }
        .scn-submit:hover:not(:disabled) { background: var(--accent-faint); }
        .scn-submit:disabled { opacity: 0.45; cursor: default; }
      `}</style>

      <div class="scn-head">
        <div class="hud-label scn-title">Connectors</div>
        <p class="scn-desc">
          Connect Google services so the assistant can read/write your calendar, docs, drive, and mail. Each
          needs OAuth credentials from Google Cloud.
        </p>
      </div>

      <button type="button" class="scn-help-toggle" onClick={() => setShowHelp(!showHelp())}>
        <span>{showHelp() ? "▾" : "▸"}</span> How to set up (Google Cloud)
      </button>
      <Show when={showHelp()}>
        <pre class="scn-help-body">{HELP_TEXT}</pre>
      </Show>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="scn-loading">Loading…</div>}>
        <div class="scn-list">
          <For each={CATALOG}>
            {(entry) => {
              const row = () => rowFor(entry.service)
              const added = () => Boolean(row())
              const isOn = () => Boolean(row()?.enabled)
              const risk = () => row()?.risk || entry.risk
              return (
                <div class="scn-card" classList={{ on: isOn() }}>
                  <div class="scn-card-row">
                    <NavIcon glyph="mcp" color={isOn() ? theme.accent : theme.textFaint} glow={isOn()} />
                    <div class="scn-card-text">
                      <div class="scn-card-label">{entry.label}</div>
                      <div class="scn-card-blurb">{entry.blurb}</div>
                    </div>
                    <span class="scn-risk" classList={{ medium: risk() === "medium", high: risk() === "high" }}>
                      {risk()}
                    </span>
                    <Show when={added()}>
                      <span class="scn-badge" classList={{ on: isOn() }}>
                        {isOn() ? "Connected" : "Added (no creds)"}
                      </span>
                    </Show>
                    <Show
                      when={added()}
                      fallback={
                        <>
                          <button
                            type="button"
                            class="scn-connect-btn"
                            disabled={busy() === entry.service}
                            onClick={() => void connectGoogle(entry)}
                          >
                            {busy() === entry.service ? "Connecting…" : "Connect with Google"}
                          </button>
                          <button
                            type="button"
                            class="scn-help-toggle"
                            title="Enter Client ID / secret / refresh token by hand"
                            onClick={() => toggleConnect(entry.service)}
                          >
                            {expanded() === entry.service ? "cancel" : "manual"}
                          </button>
                        </>
                      }
                    >
                      <button
                        type="button"
                        class="scn-connect-btn"
                        disabled={busy() === entry.service}
                        onClick={() => void disconnect(entry)}
                      >
                        {busy() === entry.service ? "…" : "Disconnect"}
                      </button>
                    </Show>
                  </div>

                  <Show when={expanded() === entry.service && !added()}>
                    <div class="scn-form">
                      <input
                        class="scn-input"
                        placeholder="Client ID"
                        value={clientId()}
                        onInput={(e) => setClientId(e.currentTarget.value)}
                      />
                      <input
                        class="scn-input"
                        type="password"
                        placeholder="Client secret"
                        value={clientSecret()}
                        onInput={(e) => setClientSecret(e.currentTarget.value)}
                      />
                      <input
                        class="scn-input"
                        type="password"
                        placeholder="Refresh token"
                        value={refreshToken()}
                        onInput={(e) => setRefreshToken(e.currentTarget.value)}
                      />
                      <button
                        type="button"
                        class="scn-submit"
                        disabled={busy() === entry.service}
                        onClick={() => void connect(entry)}
                      >
                        {busy() === entry.service ? "Connecting…" : `Connect ${entry.label}`}
                      </button>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "connectors", label: "Connectors", component: ConnectorsSection }
export default section
