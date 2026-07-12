// SETTINGS · PHONE / TWILIO — real config for the Jarvis phone server
// (call/SMS agent) and its Twilio integration, wired to the daemon's
// control(loopback)-only phone.config{action:"get"|"set"|"test"} verb (see
// daemon/src/ControlServer.cpp's handlePhoneConfig — deliberately absent from
// isConfigMethod() so it never reaches the phone/device channel, since it can
// write live secrets). Secrets (admin/device/agent tokens, Twilio Account SID
// + Auth Token) are write-only — "get" only ever returns has_* booleans,
// never the value — same masked-credential idiom as ./api-keys.tsx (only
// entries the user actually typed land in the patch, so an untouched field
// can never clobber a saved credential). Plain fields (From Number, Twilio
// webhook base URL, inbound/screening extension, server port) round-trip
// normally.
//
// The top-level "public base URL" is the one field the daemon never echoes
// back at all (only the derived server_url) — isCustomUrl() below infers
// "currently overridden" by comparing server_url against the same
// http://127.0.0.1:<port> default the daemon itself falls back to, and the
// input is treated write-only (type a new value to set it, "Reset to auto"
// to clear it) exactly like the secret fields above it.
import { createMemo, createSignal, For, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import {
  phoneConfigGet,
  phoneConfigSet,
  phoneConfigTest,
  type PhoneConfig,
  type PhoneConfigPatch,
  type PhoneConfigTestResult,
} from "../../core/control-client"
import type { SettingsSectionDef } from "./index"

interface SecretMeta {
  id: "admin_token" | "device_token" | "agent_token" | "twilio_account_sid" | "twilio_auth_token"
  label: string
  hint: string
}

const SERVER_SECRETS: SecretMeta[] = [
  { id: "admin_token", label: "Admin token", hint: "Full admin access to the phone server's REST API." },
  { id: "device_token", label: "Device token", hint: "Used by jarvisd's own phone event-bridge connection (extension 100)." },
  { id: "agent_token", label: "Agent token", hint: "Used by every phone.mcp / phone.http call this daemon makes on your behalf." },
]

const TWILIO_SECRETS: SecretMeta[] = [
  { id: "twilio_account_sid", label: "Account SID", hint: "From the Twilio Console — identifies your Twilio account." },
  { id: "twilio_auth_token", label: "Auth token", hint: "From the Twilio Console — authenticates Twilio API calls." },
]

function isSecretSet(cfg: PhoneConfig | null, id: SecretMeta["id"]): boolean {
  if (!cfg) return false
  switch (id) {
    case "admin_token":
      return cfg.has_admin_token
    case "device_token":
      return cfg.has_device_token
    case "agent_token":
      return cfg.has_agent_token
    case "twilio_account_sid":
      return cfg.twilio.has_account_sid
    case "twilio_auth_token":
      return cfg.twilio.has_auth_token
  }
}

function SecretRow(props: {
  meta: SecretMeta
  cfg: PhoneConfig | null
  pending: Record<string, string>
  onInput: (id: string, v: string) => void
  onClear: (id: string) => void
  onUndo: (id: string) => void
}) {
  const set = () => isSecretSet(props.cfg, props.meta.id)
  const isPending = () => Object.prototype.hasOwnProperty.call(props.pending, props.meta.id)
  const willClear = () => isPending() && props.pending[props.meta.id].trim().length === 0

  return (
    <div class="sph-row-block">
      <div class="sph-row-head">
        <span class="sph-field-label">{props.meta.label}</span>
        <span class="sph-badge" classList={{ set: set() }}>
          {set() ? "saved" : "empty"}
        </span>
      </div>
      <div class="sph-hint">{props.meta.hint}</div>
      <div class="sph-input-row">
        <input
          type="password"
          autocomplete="off"
          class="sph-input"
          classList={{ pending: isPending() }}
          placeholder={set() ? "•••••••••• (set — type to replace)" : "Paste value…"}
          value={props.pending[props.meta.id] ?? ""}
          onInput={(e) => props.onInput(props.meta.id, e.currentTarget.value)}
        />
        <Show
          when={isPending()}
          fallback={
            <button type="button" class="sph-clear-btn" disabled={!set()} onClick={() => props.onClear(props.meta.id)}>
              Clear
            </button>
          }
        >
          <button type="button" class="sph-clear-btn" onClick={() => props.onUndo(props.meta.id)}>
            Undo
          </button>
        </Show>
      </div>
      <Show when={willClear()}>
        <div class="sph-pending-note">will clear this credential on Save</div>
      </Show>
    </div>
  )
}

const CSS = `
.sph-page { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
.sph-title { color: var(--accent); font-size: 11px; }
.sph-desc { color: var(--text-faint); font-size: 12px; line-height: 1.5; margin: 6px 0 0; }
.sph-empty { color: var(--text-faint); font-size: 12px; }
.sph-error-inline { color: var(--danger); font-size: 12px; }
.sph-section-title { font-size: 9px; color: var(--text-faint); letter-spacing: var(--track-wide); margin: 4px 0 -4px; }

.sph-block {
  background: var(--surface-strong); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;
}
.sph-status-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sph-label-muted { color: var(--text-muted); font-size: 11px; }
.sph-mono { font-family: var(--font-mono); font-size: 11px; color: var(--text); }
.sph-mono.success { color: var(--success); }
.sph-mono.danger { color: var(--danger); }
.sph-test-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 2px; border-top: 1px solid var(--hairline-faint); }

.sph-field-label { color: var(--text); font-size: 13px; font-weight: 600; }
.sph-hint { color: var(--text-faint); font-size: 11px; line-height: 1.4; }
.sph-input-row { display: flex; gap: 8px; }
.sph-input {
  flex: 1; min-width: 0; background: var(--surface-input); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-xs); color: var(--text); font-family: var(--font-mono); font-size: 13px;
  padding: 8px 10px; transition: border-color var(--dur-fast) ease;
}
.sph-input:focus { outline: none; border-color: var(--accent-dim); }
.sph-input.pending { border-color: var(--amber); }
.sph-input:disabled { opacity: 0.5; }
.sph-clear-btn {
  all: unset; cursor: pointer; padding: 6px 12px; border-radius: var(--radius-xs);
  font-family: var(--font-display); font-size: 10px; letter-spacing: var(--track-mid);
  color: var(--text-faint); border: 1px solid var(--hairline-soft); background: var(--surface); white-space: nowrap;
}
.sph-clear-btn:hover:not(:disabled) { color: var(--danger); border-color: var(--danger-dim); }
.sph-clear-btn:disabled { opacity: 0.4; cursor: default; }
.sph-clear-btn.active { color: var(--amber); border-color: var(--amber); }
.sph-pending-note { color: var(--amber); font-size: 11px; }

.sph-row-block { display: flex; flex-direction: column; gap: 6px; }
.sph-row-head { display: flex; align-items: center; gap: 10px; }
.sph-badge {
  flex-shrink: 0; border-radius: 7px; padding: 2px 9px; font-size: 10px; letter-spacing: 0.4px;
  border: 1px solid var(--hairline); color: var(--text-faint);
}
.sph-badge.set { border-color: var(--success); color: var(--success); }

.sph-field { display: flex; flex-direction: column; gap: 6px; }

.sph-save-row {
  position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; justify-content: flex-end;
  padding-top: 8px; background: linear-gradient(180deg, transparent 0%, var(--surface) 40%);
}
.sph-dirty-note { color: var(--amber); font-size: 11px; margin-right: auto; }
.sph-btn {
  all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
  padding: 9px 18px; border-radius: var(--radius-xs);
  font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
  border: 1px solid var(--accent-dim); color: var(--accent-bright);
  background: var(--accent-faint); transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
}
.sph-btn:hover:not(:disabled) { background: var(--accent-dim); }
.sph-btn:disabled { opacity: 0.4; cursor: default; }
`

function PhoneTwilioSettings() {
  const app = useApp()
  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal("")
  const [saveError, setSaveError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [cfg, setCfg] = createSignal<PhoneConfig | null>(null)

  // Plain (round-tripped) fields — bound directly, diffed against `baseline`.
  const [serverPort, setServerPort] = createSignal("")
  const [fromNumber, setFromNumber] = createSignal("")
  const [twilioBaseUrl, setTwilioBaseUrl] = createSignal("")
  const [inboundExt, setInboundExt] = createSignal("")
  const [screeningExt, setScreeningExt] = createSignal("")
  let baseline = { server_port: "", from_number: "", twilio_public_base_url: "", inbound_extension: "", screening_extension: "" }

  // Write-only override — the daemon never echoes the raw public_base_url
  // back (see file header), so this behaves like a secret field: type a new
  // value to set it, or "Reset to auto" to clear it.
  const [publicBaseUrlInput, setPublicBaseUrlInput] = createSignal("")
  const [resetPublicBaseUrl, setResetPublicBaseUrl] = createSignal(false)

  // Secrets — only entries the user actually typed land here, so an
  // untouched field can never clobber a saved token/credential.
  const [secretPending, setSecretPending] = createSignal<Record<string, string>>({})

  const [testBusy, setTestBusy] = createSignal(false)
  const [testResult, setTestResult] = createSignal<PhoneConfigTestResult | null>(null)
  const [testError, setTestError] = createSignal("")

  const load = async () => {
    setLoading(true)
    setLoadError("")
    try {
      const r = await phoneConfigGet(app.client)
      setCfg(r)
      setServerPort(r.server_port)
      setFromNumber(r.twilio.from_number)
      setTwilioBaseUrl(r.twilio.public_base_url)
      setInboundExt(r.twilio.inbound_extension)
      setScreeningExt(r.twilio.screening_extension)
      baseline = {
        server_port: r.server_port,
        from_number: r.twilio.from_number,
        twilio_public_base_url: r.twilio.public_base_url,
        inbound_extension: r.twilio.inbound_extension,
        screening_extension: r.twilio.screening_extension,
      }
      setPublicBaseUrlInput("")
      setResetPublicBaseUrl(false)
      setSecretPending({})
    } catch (e) {
      setLoadError(String(e))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const isCustomUrl = createMemo(() => {
    const c = cfg()
    return c !== null && c.server_url !== `http://127.0.0.1:${c.server_port}`
  })

  const secretDirty = createMemo(() => Object.keys(secretPending()).length > 0)
  const plainDirty = createMemo(
    () =>
      serverPort() !== baseline.server_port ||
      fromNumber() !== baseline.from_number ||
      twilioBaseUrl() !== baseline.twilio_public_base_url ||
      inboundExt() !== baseline.inbound_extension ||
      screeningExt() !== baseline.screening_extension,
  )
  const urlDirty = createMemo(() => publicBaseUrlInput().trim().length > 0 || resetPublicBaseUrl())
  const dirty = createMemo(() => secretDirty() || plainDirty() || urlDirty())

  const onSecretInput = (id: string, v: string) => setSecretPending((p) => ({ ...p, [id]: v }))
  const onSecretClear = (id: string) => setSecretPending((p) => ({ ...p, [id]: "" }))
  const onSecretUndo = (id: string) =>
    setSecretPending((p) => {
      const next = { ...p }
      delete next[id]
      return next
    })

  const save = async () => {
    if (saving() || !dirty()) return
    setSaving(true)
    setSaveError("")
    try {
      const patch: PhoneConfigPatch = {}
      if (serverPort().trim() !== baseline.server_port) patch.server_port = serverPort().trim()
      if (fromNumber().trim() !== baseline.from_number) patch.twilio_from_number = fromNumber().trim()
      if (twilioBaseUrl().trim() !== baseline.twilio_public_base_url) patch.twilio_public_base_url = twilioBaseUrl().trim()
      if (inboundExt().trim() !== baseline.inbound_extension) patch.twilio_inbound_extension = inboundExt().trim()
      if (screeningExt().trim() !== baseline.screening_extension) patch.twilio_screening_extension = screeningExt().trim()
      if (resetPublicBaseUrl()) patch.public_base_url = ""
      else if (publicBaseUrlInput().trim()) patch.public_base_url = publicBaseUrlInput().trim()
      for (const [k, v] of Object.entries(secretPending())) patch[k as keyof PhoneConfigPatch] = v

      const res = await phoneConfigSet(app.client, patch)
      app.notify(res.restarted ? "Phone config saved — phone server restarted." : `Phone config saved — ${res.note}`, "info")
      await load()
    } catch (e) {
      setSaveError(String(e))
      app.notify(`Failed to save phone config: ${String(e)}`, "error")
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTestBusy(true)
    setTestError("")
    setTestResult(null)
    try {
      setTestResult(await phoneConfigTest(app.client))
    } catch (e) {
      setTestError(String(e))
    } finally {
      setTestBusy(false)
    }
  }

  return (
    <div class="sph-page">
      <style>{CSS}</style>

      <div>
        <div class="hud-label sph-title">Phone / Twilio</div>
        <p class="sph-desc">
          Configure the Cindro phone server (call/SMS agent) and its Twilio integration for real inbound/outbound
          calls and texts. Tokens and Twilio credentials are write-only — the daemon never sends a saved value
          back, only whether one is set. Saving restarts the phone server automatically on Linux; on Windows,
          restart it yourself to apply changes.
        </p>
      </div>

      <Show when={loadError()}>
        <div class="sph-error-inline">⚠ {loadError()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="sph-empty">Loading phone config…</div>}>
        <div class="sph-block">
          <div class="sph-status-row">
            <span class="sph-label-muted">Status:</span>
            <span class="sph-mono" classList={{ success: cfg()?.configured === true, danger: cfg()?.configured !== true }}>
              {cfg()?.configured ? "Configured" : "Not configured"}
            </span>
          </div>
          <div class="sph-status-row">
            <span class="sph-label-muted">Server URL:</span>
            <span class="sph-mono">{cfg()?.server_url || "—"}</span>
          </div>
          <div class="sph-status-row">
            <span class="sph-label-muted">Twilio:</span>
            <span
              class="sph-mono"
              classList={{ success: cfg()?.twilio.configured === true, danger: cfg()?.twilio.configured !== true }}
            >
              {cfg()?.twilio.configured ? "Configured" : "Not configured"}
            </span>
          </div>
          <div class="sph-test-row">
            <button type="button" class="sph-btn" disabled={testBusy()} onClick={() => void runTest()}>
              {testBusy() ? "Testing…" : "Test connection"}
            </button>
            <Show when={testResult()}>
              {(r) => (
                <>
                  <span class="sph-mono" classList={{ success: r().reachable, danger: !r().reachable }}>
                    {r().reachable ? "Server reachable" : "Server unreachable"}
                  </span>
                  <span class="sph-mono" classList={{ success: r().twilio_configured, danger: !r().twilio_configured }}>
                    Twilio {r().twilio_configured ? "configured" : "not configured"}
                  </span>
                </>
              )}
            </Show>
            <Show when={testError()}>
              <span class="sph-error-inline">{testError()}</span>
            </Show>
          </div>
        </div>

        <div class="sph-section-title hud-label">SERVER</div>
        <div class="sph-block">
          <label class="sph-field">
            <span class="sph-field-label">Port</span>
            <input class="sph-input" placeholder="8801" value={serverPort()} onInput={(e) => setServerPort(e.currentTarget.value)} />
          </label>

          <label class="sph-field">
            <span class="sph-field-label">Public base URL override</span>
            <div class="sph-input-row">
              <input
                class="sph-input"
                classList={{ pending: publicBaseUrlInput().trim().length > 0 }}
                placeholder={isCustomUrl() ? "•••• set — type to replace" : "auto-detected — type to override"}
                value={publicBaseUrlInput()}
                disabled={resetPublicBaseUrl()}
                onInput={(e) => setPublicBaseUrlInput(e.currentTarget.value)}
              />
              <button
                type="button"
                class="sph-clear-btn"
                classList={{ active: resetPublicBaseUrl() }}
                disabled={!isCustomUrl()}
                onClick={() => {
                  setResetPublicBaseUrl((v) => !v)
                  setPublicBaseUrlInput("")
                }}
              >
                {resetPublicBaseUrl() ? "Resetting…" : "Reset to auto"}
              </button>
            </div>
            <div class="sph-hint">
              Set this if the phone server is reachable at a different public URL (reverse proxy, tunnel). Leave
              blank to auto-detect from the port (currently: {cfg()?.server_url || "—"}).
            </div>
          </label>

          <For each={SERVER_SECRETS}>
            {(f) => (
              <SecretRow meta={f} cfg={cfg()} pending={secretPending()} onInput={onSecretInput} onClear={onSecretClear} onUndo={onSecretUndo} />
            )}
          </For>
        </div>

        <div class="sph-section-title hud-label">TWILIO</div>
        <div class="sph-block">
          <For each={TWILIO_SECRETS}>
            {(f) => (
              <SecretRow meta={f} cfg={cfg()} pending={secretPending()} onInput={onSecretInput} onClear={onSecretClear} onUndo={onSecretUndo} />
            )}
          </For>

          <label class="sph-field">
            <span class="sph-field-label">From number</span>
            <input class="sph-input" placeholder="+1XXXXXXXXXX" value={fromNumber()} onInput={(e) => setFromNumber(e.currentTarget.value)} />
          </label>

          <label class="sph-field">
            <span class="sph-field-label">Webhook base URL</span>
            <input
              class="sph-input"
              placeholder="https://your-tunnel.example.com"
              value={twilioBaseUrl()}
              onInput={(e) => setTwilioBaseUrl(e.currentTarget.value)}
            />
            <div class="sph-hint">Public HTTPS URL Twilio calls for voice/SMS webhooks — e.g. an ngrok or Cloudflare tunnel pointed at this server.</div>
          </label>

          <label class="sph-field">
            <span class="sph-field-label">Inbound extension</span>
            <input class="sph-input" placeholder="101" value={inboundExt()} onInput={(e) => setInboundExt(e.currentTarget.value)} />
            <div class="sph-hint">Who answers when you dial your own Twilio number.</div>
          </label>

          <label class="sph-field">
            <span class="sph-field-label">Screening extension</span>
            <input
              class="sph-input"
              placeholder="(defaults to inbound extension)"
              value={screeningExt()}
              onInput={(e) => setScreeningExt(e.currentTarget.value)}
            />
            <div class="sph-hint">Who screens unknown callers. Leave blank to fall back to the inbound extension.</div>
          </label>
        </div>

        <Show when={saveError()}>
          <div class="sph-error-inline">⚠ {saveError()}</div>
        </Show>

        <div class="sph-save-row">
          <Show when={dirty()}>
            <span class="sph-dirty-note">Unsaved changes</span>
          </Show>
          <button type="button" class="sph-btn" disabled={!dirty() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "phone", label: "Phone / Twilio", component: PhoneTwilioSettings }
export default section
