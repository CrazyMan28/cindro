// The pairing/token gate — shown instead of the app shell whenever there's no
// control token in localStorage yet. Ported from web/app.js's original Setup
// tab (pairWithCode/saveTokenManually), which itself mirrors
// extension/options.js's pairing flow. Two paths: a 6-digit pairing code
// (Jarvis desktop → Settings → Browser Extension → "Generate pairing code")
// or pasting the token straight from ~/.config/jarvis/control_token.
//
// NOTE: this intentionally does NOT reimplement TUI's SetupWizard.tsx
// (first-run assistant-name/voice/brain/permissions onboarding) — that's
// covered by the Settings > Identity/Defaults/Voice pages once connected, so
// duplicating it here as a second onboarding flow would just be two sources
// of truth for the same settings.
//
// After a successful pair/token-save there's one more optional step: a
// condensed Twilio quick-setup (phone.config set — see core/control-client.ts
// and settings/phone.tsx for the full field set + docs). This runs BEFORE
// props.onDone() so the daemon client already has the fresh token (call()
// starts the client lazily and controlWsUrl() re-reads localStorage on every
// connect attempt, so it picks up the token this component just saved). Skip
// is always one click away, and the full form lives permanently at
// Settings → Phone / Twilio for anyone who skips or wants to revisit it.
import { createSignal, Show } from "solid-js"

import { useApp } from "../core/app-context"
import { controlPort, setControlPort, setControlToken } from "../core/config"
import { phoneConfigSet, type PhoneConfigPatch } from "../core/control-client"

export function SetupWizard(props: { onDone: () => void }) {
  const app = useApp()
  const [step, setStep] = createSignal<"connect" | "phone">("connect")

  const [pairCode, setPairCode] = createSignal("")
  const [pairPort, setPairPort] = createSignal(String(controlPort()))
  const [manualToken, setManualToken] = createSignal("")
  const [manualPort, setManualPort] = createSignal(String(controlPort()))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const [twAccountSid, setTwAccountSid] = createSignal("")
  const [twAuthToken, setTwAuthToken] = createSignal("")
  const [twFromNumber, setTwFromNumber] = createSignal("")
  const [twBaseUrl, setTwBaseUrl] = createSignal("")
  const [phoneBusy, setPhoneBusy] = createSignal(false)
  const [phoneError, setPhoneError] = createSignal("")

  const pairWithCode = () => {
    const code = pairCode().trim()
    if (!code) return
    const port = parseInt(pairPort(), 10) || controlPort()
    setBusy(true)
    setError("")
    let settled = false
    const sock = new WebSocket(`ws://127.0.0.1:${port}/control/pair?code=${encodeURIComponent(code)}`)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      sock.close()
      setBusy(false)
      setError("pairing timed out — check the code and try again")
    }, 15000)
    sock.onmessage = (ev) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const data = JSON.parse(ev.data) as Record<string, unknown>
        const token = String(data.control_token ?? "")
        if (!token) throw new Error("no token in pairing response")
        setControlToken(token)
        setControlPort(Number(data.control_port ?? port))
        sock.close()
        setBusy(false)
        setStep("phone")
      } catch (e) {
        setBusy(false)
        setError(`pairing failed: ${String(e)}`)
      }
    }
    sock.onerror = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setBusy(false)
      setError("pairing connection failed — is the daemon running?")
    }
    sock.onclose = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setBusy(false)
      setError("pairing socket closed before a response arrived")
    }
  }

  const saveManually = () => {
    const token = manualToken().trim()
    if (!token) {
      setError("paste a token first")
      return
    }
    setControlToken(token)
    setControlPort(parseInt(manualPort(), 10) || controlPort())
    setStep("phone")
  }

  const savePhoneAndContinue = async () => {
    const patch: PhoneConfigPatch = {}
    if (twAccountSid().trim()) patch.twilio_account_sid = twAccountSid().trim()
    if (twAuthToken().trim()) patch.twilio_auth_token = twAuthToken().trim()
    if (twFromNumber().trim()) patch.twilio_from_number = twFromNumber().trim()
    if (twBaseUrl().trim()) patch.twilio_public_base_url = twBaseUrl().trim()
    if (Object.keys(patch).length === 0) {
      props.onDone()
      return
    }
    setPhoneBusy(true)
    setPhoneError("")
    try {
      await phoneConfigSet(app.client, patch)
      props.onDone()
    } catch (e) {
      setPhoneError(`Could not save phone config: ${String(e)} — you can try again later in Settings → Phone / Twilio.`)
    } finally {
      setPhoneBusy(false)
    }
  }

  return (
    <div class="setup-gate">
      <style>{`
        .setup-row { display: flex; gap: 8px; }
        .setup-row button { flex: 1; }
        .setup-secondary { background: transparent !important; color: var(--text-muted) !important; border-color: var(--hairline-soft) !important; }
        .setup-secondary:hover { background: rgba(255,255,255,0.06) !important; }
      `}</style>
      <Show when={step() === "connect"}>
        <div class="setup-card">
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "13px" }}>
            CONNECT TO ORIN
          </div>
          <div style={{ color: "var(--text-muted)", "font-size": "12px" }}>
            Pair with a 6-digit code from the desktop app (Settings → Browser
            Extension → Generate pairing code), or paste your control token.
          </div>

          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <input
              placeholder="Pairing code (6 digits)"
              value={pairCode()}
              maxLength={6}
              onInput={(e) => setPairCode(e.currentTarget.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") pairWithCode()
              }}
            />
            <input
              placeholder="Port (default 8795)"
              value={pairPort()}
              onInput={(e) => setPairPort(e.currentTarget.value)}
            />
            <button type="button" disabled={busy()} onClick={pairWithCode}>
              {busy() ? "PAIRING…" : "PAIR WITH CODE"}
            </button>
          </div>

          <div style={{ height: "1px", background: "var(--hairline-soft)" }} />

          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <input
              placeholder="Paste control token"
              value={manualToken()}
              onInput={(e) => setManualToken(e.currentTarget.value)}
            />
            <input
              placeholder="Port (default 8795)"
              value={manualPort()}
              onInput={(e) => setManualPort(e.currentTarget.value)}
            />
            <button type="button" onClick={saveManually}>
              SAVE TOKEN
            </button>
          </div>

          <Show when={error()}>
            <div class="setup-error">⚠ {error()}</div>
          </Show>
        </div>
      </Show>

      <Show when={step() === "phone"}>
        <div class="setup-card">
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "13px" }}>
            SET UP PHONE CALLS (TWILIO) — OPTIONAL
          </div>
          <div style={{ color: "var(--text-muted)", "font-size": "12px" }}>
            Connect Twilio so Orin can make and screen real calls and texts. Skip this and set it up any time
            later from Settings → Phone / Twilio.
          </div>

          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <input
              placeholder="Twilio Account SID"
              value={twAccountSid()}
              onInput={(e) => setTwAccountSid(e.currentTarget.value)}
            />
            <input
              type="password"
              placeholder="Twilio Auth Token"
              value={twAuthToken()}
              onInput={(e) => setTwAuthToken(e.currentTarget.value)}
            />
            <input
              placeholder="Twilio phone number (+1XXXXXXXXXX)"
              value={twFromNumber()}
              onInput={(e) => setTwFromNumber(e.currentTarget.value)}
            />
            <input
              placeholder="Webhook base URL (optional — e.g. ngrok tunnel)"
              value={twBaseUrl()}
              onInput={(e) => setTwBaseUrl(e.currentTarget.value)}
            />
          </div>

          <Show when={phoneError()}>
            <div class="setup-error">⚠ {phoneError()}</div>
          </Show>

          <div class="setup-row">
            <button type="button" disabled={phoneBusy()} onClick={() => void savePhoneAndContinue()}>
              {phoneBusy() ? "SAVING…" : "SAVE & CONTINUE"}
            </button>
            <button type="button" class="setup-secondary" disabled={phoneBusy()} onClick={() => props.onDone()}>
              SKIP FOR NOW
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
