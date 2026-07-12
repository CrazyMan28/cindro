// SETTINGS · EXTENSION — regenerate a browser pairing code from inside a
// connected session. Same daemon verb + single-use code pool as the initial
// pairing gate (components/SetupWizard.tsx's "PAIR WITH CODE" path connects a
// fresh WebSocket to ws://127.0.0.1:<port>/control/pair?code=... and consumes
// whichever code is live — extension.pair_start and devices.pair_start both
// mint from the same PairingManager, per ControlServer.cpp's
// handleExtensionPairStart/handleDevicesPairStart) so a code minted here works
// to pair either a brand new browser tab of this dashboard OR the Jarvis
// Chrome/Edge extension's Options -> "Pair with a code" field.
//
// Unlike devices.pair_start, handleExtensionPairStart only returns
// {code, expires_at, control_port} — no payload/qr_svg — so this view shows
// the bare code big and countable, no QR (devices.tsx's Pair-a-phone flow is
// the one with a QR, since it does get qr_svg back).
import { createSignal, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

interface PairStartResult {
  code: string
  expires_at: number
  control_port: number
}

function ExtensionSection() {
  const app = useApp()
  const [code, setCode] = createSignal("")
  const [expiresAt, setExpiresAt] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [copied, setCopied] = createSignal(false)

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const remaining = () => Math.max(0, Math.floor((expiresAt() - now()) / 1000))
  const hasCode = () => code().length > 0

  const generate = async () => {
    setBusy(true)
    setError("")
    setCopied(false)
    try {
      const res = (await app.client.call("extension.pair_start", {}, 15000)) as unknown as PairStartResult
      setCode(res.code || "")
      setExpiresAt(Number(res.expires_at) || 0)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      app.notify("Copy failed — select and copy the code manually.", "warn")
    }
  }

  return (
    <div class="sext-page">
      <style>{`
        .sext-page { display: flex; flex-direction: column; gap: 16px; max-width: 480px; animation: sext-in var(--dur-slow) ease-out; }
        @keyframes sext-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .sext-title { color: var(--accent); font-size: 11px; }
        .sext-desc { color: var(--text-faint); font-size: 12px; margin: 6px 0 0; line-height: 1.5; }
        .sext-actions { display: flex; align-items: center; gap: 10px; }
        .sext-gen {
          all: unset; cursor: pointer; padding: 9px 20px; border-radius: var(--radius-xs);
          background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim);
          font-family: var(--font-display); letter-spacing: var(--track-mid); font-size: 12px;
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .sext-gen:hover:not(:disabled) { background: var(--accent-faint); }
        .sext-gen:disabled { opacity: 0.5; cursor: default; }
        .sext-panel {
          position: relative; border-radius: var(--radius-sm); background: var(--surface-deep);
          border: 1px solid var(--accent-dim); padding: 18px; overflow: hidden;
        }
        .sext-panel::before {
          content: ""; position: absolute; top: 1px; left: 14px; right: 14px; height: 1px;
          background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: 0.7;
        }
        .sext-panel-label {
          color: var(--text-muted); font-family: var(--font-display); font-size: 10px; letter-spacing: var(--track-wide);
        }
        .sext-code {
          color: var(--accent-bright); font-family: var(--font-mono); font-size: 32px; font-weight: 600;
          letter-spacing: 7px; margin: 8px 0;
        }
        .sext-status-row { display: flex; align-items: center; gap: 6px; }
        .sext-dot { width: 7px; height: 7px; border-radius: 50%; }
        .sext-dot.ok { background: var(--success); }
        .sext-dot.warn { background: var(--amber); }
        .sext-dot.dead { background: var(--danger); }
        .sext-remaining { font-size: 12px; color: var(--text-muted); }
        .sext-remaining.dead { color: var(--danger); }
        .sext-copy-row { margin-top: 12px; display: flex; gap: 8px; }
        .sext-copy {
          all: unset; cursor: pointer; padding: 6px 14px; border-radius: var(--radius-xs);
          border: 1px solid var(--hairline-soft); color: var(--text-muted); font-size: 11px;
          font-family: var(--font-display); letter-spacing: var(--track-mid);
          transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease;
        }
        .sext-copy:hover { border-color: var(--accent-dim); color: var(--accent); }
        .sext-hint {
          color: var(--text-faint); font-size: 11.5px; line-height: 1.6; background: var(--panel-soft);
          border: 1px solid var(--hairline-faint); border-radius: var(--radius-sm); padding: 10px 12px;
        }
        .sext-hint b { color: var(--text-muted); }
      `}</style>

      <div class="sext-head">
        <div class="hud-label sext-title">Browser Extension</div>
        <p class="sext-desc">
          Pair a new browser (another tab, profile, or the Cindro Chrome/Edge extension) with one code — no
          copying a token by hand. Single-use, expires in 5 minutes.
        </p>
      </div>

      <div class="sext-actions">
        <button type="button" class="sext-gen" disabled={busy()} onClick={() => void generate()}>
          {busy() ? "Generating…" : hasCode() ? "New code" : "Generate pairing code"}
        </button>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={hasCode()}>
        <div class="sext-panel">
          <div class="sext-panel-label">PAIRING CODE</div>
          <div class="sext-code">{code()}</div>
          <div class="sext-status-row">
            <span class="sext-dot" classList={{ ok: remaining() > 30, warn: remaining() > 0 && remaining() <= 30, dead: remaining() <= 0 }} />
            <span class="sext-remaining" classList={{ dead: remaining() <= 0 }}>
              {remaining() > 0 ? `Expires in ${remaining()}s` : "Expired — generate a new code"}
            </span>
          </div>
          <div class="sext-copy-row">
            <button type="button" class="sext-copy" onClick={() => void copyCode()}>
              {copied() ? "Copied ✓" : "Copy code"}
            </button>
          </div>
        </div>
      </Show>

      <div class="sext-hint">
        <b>On the new browser:</b> open this dashboard, and at the "CONNECT TO CINDRO" screen paste this code
        into the <b>Pairing code</b> field.
        <br />
        <b>For the Cindro extension:</b> open its Options page and paste this code into "Pair with a code" —
        it fills in both tokens for you.
      </div>
    </div>
  )
}

const section: SettingsSectionDef = { key: "extension", label: "Extension", component: ExtensionSection }
export default section
