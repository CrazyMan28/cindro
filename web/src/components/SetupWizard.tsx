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
import { createSignal, Show } from "solid-js"

import { controlPort, setControlPort, setControlToken } from "../core/config"

export function SetupWizard(props: { onDone: () => void }) {
  const [pairCode, setPairCode] = createSignal("")
  const [pairPort, setPairPort] = createSignal(String(controlPort()))
  const [manualToken, setManualToken] = createSignal("")
  const [manualPort, setManualPort] = createSignal(String(controlPort()))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

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
        props.onDone()
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
    props.onDone()
  }

  return (
    <div class="setup-gate">
      <div class="setup-card">
        <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "13px" }}>
          CONNECT TO JARVIS
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
    </div>
  )
}
