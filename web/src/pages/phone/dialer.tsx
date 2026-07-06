// CALLS tab body — ported from desktop/qml/PhoneDialerTab.qml (dial pad +
// quick-dial chips + active-call banner + active-calls list + per-call
// transcript + extended IN-APP/PSTN dialer) with tui/src/phone/api.ts +
// tabs/CallsTab.tsx as the confirmed phone.mcp call shapes for a non-Qt
// client. Everything travels over the two generic proxy verbs — phone.mcp
// {name, arguments} and phone.http {method, path, body} — jarvisd holds the
// real Twilio/phone bearer (see the unit brief's phone.mcp/phone.http note).
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { ControlClient } from "../../core/control-client"
import { NavIcon } from "../../components/NavIcon"
import { PhoneTabPanel, usePhoneTab } from "./index"

// -- local phone.mcp / phone.http wrappers (self-contained — no shared
// pages/phone/api.ts exists yet, and this unit only owns dialer.tsx +
// agents-tab.tsx, so each file carries its own small copy, same as how
// pages/agents.tsx carries its own str()/timeAgo() rather than importing
// a shared util). Shape ported 1:1 from tui/src/phone/api.ts. -------------
interface PhoneErr {
  code: string
  message: string
}
interface McpRes {
  tool?: string
  data?: unknown
  error?: PhoneErr
}
type Row = Record<string, unknown>

async function phoneMcp(client: ControlClient, name: string, args: Row = {}): Promise<McpRes> {
  try {
    return (await client.call("phone.mcp", { name, arguments: args }, 30000)) as McpRes
  } catch (e) {
    return { tool: name, error: { code: "transport_error", message: String(e) } }
  }
}

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

function asList(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[]
  return []
}

// PhoneDialerTab.qml:363-365 state dot colors.
function callStateColor(state: string): string {
  if (state === "active") return "var(--success)"
  if (state === "ringing") return "var(--amber)"
  if (state === "speaking") return "var(--accent)"
  return "var(--text-faint)"
}

interface TranscriptLine {
  speaker: string
  body: string
  isAgent: boolean
}

// phone_pane.py:_load_call_transcript merge order — STT utterances first,
// then agent call messages.
function mergeTranscript(data: unknown): TranscriptLine[] {
  const d = (data ?? {}) as Row
  const lines: TranscriptLine[] = []
  for (const t of asList(d.transcripts)) {
    lines.push({
      speaker: t.from_extension !== undefined ? `ext ${str(t.from_extension)}` : "caller",
      body: str(t.text),
      isAgent: false,
    })
  }
  for (const m of asList(d.messages)) {
    lines.push({
      speaker: m.from_extension !== undefined ? `ext ${str(m.from_extension)}` : "agent",
      body: str(m.content) || str(m.text),
      isAgent: true,
    })
  }
  return lines
}

const EXTENSION_RE = /^\d{1,6}$/
const QUICK_DIAL = ["101", "102", "103", "104", "105", "900"]
const KEYPAD_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
]

interface CallRow {
  id: string
  state: string
  fromExt: string
  toExt: string
  reason: string
}

function toCallRow(c: Row): CallRow {
  return {
    id: str(c.id),
    state: str(c.state, "unknown"),
    fromExt: str(c.from_extension, "—"),
    toExt: str(c.to_extension, "—"),
    reason: str(c.reason),
  }
}

export function PhoneDialerTab() {
  const app = useApp()
  const ctx = usePhoneTab()

  const [dialBuffer, setDialBuffer] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [activeCallId, setActiveCallId] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [statusKind, setStatusKind] = createSignal<"info" | "error" | "success">("info")

  const [calls, setCalls] = createSignal<CallRow[]>([])
  const [callsError, setCallsError] = createSignal("")

  const [transcriptFor, setTranscriptFor] = createSignal("")
  const [transcript, setTranscript] = createSignal<TranscriptLine[]>([])
  const [transcriptLoading, setTranscriptLoading] = createSignal(false)

  const [pstn, setPstn] = createSignal(false)
  const [reason, setReason] = createSignal("")
  const [pstnNumber, setPstnNumber] = createSignal("")
  const [sayText, setSayText] = createSignal("")

  const [connected, setConnected] = createSignal(app.client.connected)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const note = (msg: string, kind: "info" | "error" | "success" = "info") => {
    if (!alive) return
    setStatus(msg)
    setStatusKind(kind)
  }

  const refresh = async () => {
    const res = await phoneMcp(app.client, "list_active_calls")
    if (!alive) return
    if (res.error) {
      setCallsError(res.error.message)
      return
    }
    setCallsError("")
    setCalls(asList(res.data).map(toCallRow))
  }

  onMount(() => {
    const poll = setInterval(() => setConnected(app.client.connected), 500)
    onCleanup(() => clearInterval(poll))
  })

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    onCleanup(() => clearInterval(timer))
  })

  // Shell's refresh (↺) button re-fires this tab's data load without a full
  // remount — mirrors the contract note in phone/index.tsx.
  createEffect(on(ctx.refreshNonce, () => void refresh(), { defer: true }))

  const dialExtension = async (ext: string) => {
    if (busy()) return
    setBusy(true)
    note(`Ringing ${ext}…`)
    const res = await phoneMcp(app.client, "call_extension", { from_extension: "100", extension: ext })
    if (!alive) return
    setBusy(false)
    if (res.error) {
      note(`Error: ${res.error.message}`, "error")
    } else {
      const d = (res.data ?? {}) as Row
      setActiveCallId(str(d.call_id) || str(d.id))
      note(`Connected to ${ext}`, "success")
    }
    void refresh()
  }

  const dialUser = async (why: string) => {
    if (busy()) return
    setBusy(true)
    note("Calling user…")
    const res = await phoneMcp(app.client, "call_user", { reason: why || "Desktop call" })
    if (!alive) return
    setBusy(false)
    if (res.error) {
      note(`Error: ${res.error.message}`, "error")
    } else {
      const d = (res.data ?? {}) as Row
      setActiveCallId(str(d.call_id) || str(d.id))
      note("In-app call placed", "success")
    }
    void refresh()
  }

  // Numeric target -> extension dial, anything else -> in-app user call
  // (PhoneDialerTab.qml:242-245 split).
  const dial = (target: string) => {
    const t = target.trim()
    if (!t) return
    if (EXTENSION_RE.test(t)) void dialExtension(t)
    else void dialUser(`Desktop call to ${t}`)
  }

  const endCall = async (callId: string) => {
    const res = await phoneMcp(app.client, "end_call", { call_id: callId })
    if (!alive) return
    if (res.error) note(`end_call: ${res.error.message}`, "error")
    else note("Call ended", "success")
    if (activeCallId() === callId) setActiveCallId("")
    if (transcriptFor() === callId) {
      setTranscriptFor("")
      setTranscript([])
    }
    void refresh()
  }

  const loadTranscript = async (callId: string) => {
    setTranscriptFor(callId)
    setTranscriptLoading(true)
    setTranscript([])
    const res = await phoneMcp(app.client, "get_call_transcript", { call_id: callId })
    if (!alive) return
    setTranscriptLoading(false)
    if (res.error) {
      note(`transcript: ${res.error.message}`, "error")
      return
    }
    setTranscript(mergeTranscript(res.data))
  }

  const pressDigit = (d: string) => {
    setDialBuffer((b) => (b.length < 15 ? b + d : b))
  }

  const extendedDial = async () => {
    if (busy()) return
    if (!pstn()) {
      void dialUser(reason().trim() || "Calling from desktop")
      return
    }
    const num = pstnNumber().trim()
    if (!num) {
      note("Enter a phone number to place a PSTN call.", "error")
      return
    }
    setBusy(true)
    note("Placing PSTN call…")
    const res = await phoneMcp(app.client, "twilio_call_and_wait", {
      to_number: num,
      reason: reason().trim() || "Desktop call",
      say: sayText(),
    })
    if (!alive) return
    setBusy(false)
    if (res.error) note(`PSTN Error: ${res.error.message}`, "error")
    else note("PSTN call placed", "success")
    void refresh()
  }

  const dialButtonEnabled = () => dialBuffer().trim().length > 0 && !busy()

  return (
    <PhoneTabPanel>
      <style>{DIALER_CSS}</style>
      <div class="phdial-grid">
        {/* ── left: dial pad ─────────────────────────────────────────── */}
        <div class="card phdial-pad">
          <div class="phdial-display">{dialBuffer().length > 0 ? dialBuffer() : "•"}</div>
          <div class="phdial-display-sub">
            {busy() ? "Calling…" : connected() ? "Ready to dial." : "Connecting to the daemon…"}
          </div>

          <div class="phdial-quickrow">
            <For each={QUICK_DIAL}>
              {(ext) => (
                <button type="button" class="phdial-chip" onClick={() => setDialBuffer(ext)}>
                  {ext}
                </button>
              )}
            </For>
          </div>

          <div class="phdial-keypad">
            <For each={KEYPAD_ROWS}>
              {(row) => (
                <div class="phdial-keyrow">
                  <For each={row}>
                    {(d) => (
                      <button type="button" class="phdial-key" onClick={() => pressDigit(d)}>
                        {d}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>

          <div class="phdial-actionrow">
            <button
              type="button"
              class="phdial-backspace"
              disabled={dialBuffer().length === 0}
              onClick={() => setDialBuffer((b) => b.slice(0, -1))}
              title="Backspace"
            >
              ⌫
            </button>
            <button
              type="button"
              class="phdial-callbtn"
              classList={{ busy: busy() }}
              disabled={!dialButtonEnabled()}
              onClick={() => dial(dialBuffer())}
              title="Call"
            >
              <span class="phdial-callring" classList={{ ringing: busy() }} />
              <span class="phdial-callglyph">✆</span>
            </button>
            <div style={{ width: "44px" }} />
          </div>

          <Show when={status()}>
            <div
              class="phdial-status"
              classList={{ error: statusKind() === "error", success: statusKind() === "success" }}
            >
              {status()}
            </div>
          </Show>
        </div>

        {/* ── right: active calls + extended dialer ─────────────────── */}
        <div class="phdial-col">
          <Show when={activeCallId()}>
            <div class="card phdial-activecard">
              <div class="phdial-activeicon">
                <NavIcon glyph="phone" color="var(--accent)" glow />
              </div>
              <div class="phdial-activetext">
                <div class="phdial-activetitle">Active call · {activeCallId()}</div>
                <div class="phdial-activesub">Call in progress</div>
              </div>
              <button type="button" class="phdial-pill" onClick={() => void loadTranscript(activeCallId())}>
                TRANSCRIPT
              </button>
              <button
                type="button"
                class="phdial-pill danger"
                onClick={() => void endCall(activeCallId())}
              >
                END
              </button>
            </div>
          </Show>

          <Show when={transcriptFor()}>
            <div class="card phdial-transcript">
              <div class="phdial-section-title hud-label">TRANSCRIPT · {transcriptFor()}</div>
              <div class="phdial-transcript-body">
                <Show when={transcriptLoading()}>
                  <div class="phdial-empty">Loading…</div>
                </Show>
                <Show when={!transcriptLoading() && transcript().length === 0}>
                  <div class="phdial-empty">(no messages yet)</div>
                </Show>
                <For each={transcript()}>
                  {(line) => (
                    <div class="phdial-tline" classList={{ agent: line.isAgent }}>
                      <span class="phdial-tspeaker">[{line.speaker}]</span> {line.body}
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="card phdial-callscard">
            <div class="phdial-section-title hud-label">ACTIVE CALLS</div>
            <Show when={callsError()}>
              <div class="phdial-error">⚠ {callsError()}</div>
            </Show>
            <Show when={!callsError() && calls().length === 0}>
              <div class="phdial-empty">No active calls.</div>
            </Show>
            <div class="phdial-rows">
              <For each={calls()}>
                {(c, i) => {
                  const enterDelay = Math.min(i() * 30, 240)
                  return (
                    <div
                      class="phdial-row"
                      classList={{ active: c.id === activeCallId() }}
                      style={{ "animation-delay": `${enterDelay}ms` }}
                    >
                      <span
                        class="phdial-dot"
                        classList={{ pulsing: c.state === "ringing" || c.state === "speaking" }}
                        style={{ background: callStateColor(c.state) }}
                      />
                      <div class="phdial-row-main">
                        <div class="phdial-row-title">{c.reason || `Call ${c.id}`}</div>
                        <div class="phdial-row-meta">
                          {c.fromExt} → {c.toExt} [{c.state}]
                        </div>
                      </div>
                      <button
                        type="button"
                        class="phdial-pill"
                        onClick={() => {
                          setActiveCallId(c.id)
                          void loadTranscript(c.id)
                        }}
                      >
                        TRANSCRIPT
                      </button>
                      <button type="button" class="phdial-pill danger" onClick={() => void endCall(c.id)}>
                        END
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>

          <div class="card phdial-extcard">
            <div class="phdial-section-title hud-label">EXTENDED DIALER</div>
            <div class="phdial-modetoggle">
              <button type="button" class="phdial-modebtn" classList={{ on: !pstn() }} onClick={() => setPstn(false)}>
                IN-APP
              </button>
              <button type="button" class="phdial-modebtn" classList={{ on: pstn() }} onClick={() => setPstn(true)}>
                PSTN
              </button>
            </div>
            <Show when={pstn()}>
              <input
                class="phdial-input"
                placeholder="Phone number  +1XXXXXXXXXX"
                value={pstnNumber()}
                onInput={(e) => setPstnNumber(e.currentTarget.value)}
              />
            </Show>
            <input
              class="phdial-input"
              placeholder="Reason  (e.g. Approval needed)"
              value={reason()}
              onInput={(e) => setReason(e.currentTarget.value)}
            />
            <Show when={pstn()}>
              <input
                class="phdial-input"
                placeholder="Say (TTS spoken on PSTN call)"
                value={sayText()}
                onInput={(e) => setSayText(e.currentTarget.value)}
              />
            </Show>
            <button type="button" class="phdial-extbtn" disabled={busy()} onClick={() => void extendedDial()}>
              {busy() ? "Calling…" : pstn() ? "PLACE PSTN CALL" : "CALL USER"}
            </button>
          </div>
        </div>
      </div>
    </PhoneTabPanel>
  )
}

const DIALER_CSS = `
.phdial-grid { display:grid; grid-template-columns: minmax(280px, 360px) 1fr; gap:14px; align-items:start; }
@media (max-width: 760px) { .phdial-grid { grid-template-columns: 1fr; } }
.phdial-pad { display:flex; flex-direction:column; align-items:center; gap:10px; }
.phdial-display { font-family:var(--font-mono); font-size:38px; font-weight:300; color:var(--text); letter-spacing:1px; min-height:46px; }
.phdial-display-sub { color:var(--text-faint); font-size:11px; margin-bottom:4px; }
.phdial-quickrow { display:flex; flex-wrap:wrap; gap:7px; justify-content:center; }
.phdial-chip { all:unset; cursor:pointer; height:28px; padding:0 12px; border-radius:14px; background:var(--surface-strong); border:1px solid var(--hairline-soft); color:var(--text); font-family:var(--font-mono); font-size:11px; transition:background var(--dur-fast) ease, border-color var(--dur-fast) ease; }
.phdial-chip:hover { background:var(--accent-dim); border-color:var(--accent-dim); }
.phdial-keypad { display:flex; flex-direction:column; gap:9px; width:100%; margin-top:4px; }
.phdial-keyrow { display:flex; gap:9px; }
.phdial-key { all:unset; cursor:pointer; flex:1; text-align:center; height:52px; border-radius:var(--radius-sm); background:var(--surface); border:1px solid var(--hairline-soft); color:var(--text); font-family:var(--font-display); font-size:19px; font-weight:500; transition:background var(--dur-fast) ease, transform var(--dur-fast) ease; }
.phdial-key:hover { background:var(--surface-strong); transform:translateY(-1px); }
.phdial-actionrow { display:flex; align-items:center; justify-content:center; gap:10px; margin-top:6px; width:100%; }
.phdial-backspace { all:unset; cursor:pointer; width:44px; height:44px; border-radius:var(--radius-sm); display:flex; align-items:center; justify-content:center; color:var(--text-muted); font-size:19px; transition:background var(--dur-fast) ease; }
.phdial-backspace:hover:not(:disabled) { background:var(--surface-strong); }
.phdial-backspace:disabled { opacity:0.3; cursor:default; }
.phdial-callbtn { all:unset; cursor:pointer; position:relative; width:60px; height:60px; border-radius:50%; background:var(--accent); display:flex; align-items:center; justify-content:center; box-shadow:0 0 18px -4px var(--accent-glow); transition:opacity var(--dur-fast) ease, transform var(--dur-fast) ease; }
.phdial-callbtn:hover:not(:disabled) { transform:translateY(-1px); }
.phdial-callbtn:disabled { opacity:0.4; cursor:default; }
.phdial-callbtn.busy { background:var(--accent-dim); }
.phdial-callglyph { color:var(--ink-on-accent); font-size:22px; position:relative; z-index:1; }
.phdial-callring { position:absolute; inset:-7px; border-radius:50%; border:2px solid var(--accent); opacity:0; }
.phdial-callring.ringing { animation:phdial-ring 1200ms ease-in-out infinite; }
@keyframes phdial-ring { 0% { opacity:0.6; transform:scale(0.9); } 100% { opacity:0; transform:scale(1.25); } }
.phdial-status { font-family:var(--font-mono); font-size:11px; color:var(--amber); margin-top:2px; }
.phdial-status.error { color:var(--danger); }
.phdial-status.success { color:var(--success); }
.phdial-col { display:flex; flex-direction:column; gap:12px; min-width:0; }
.phdial-section-title { font-size:10px; letter-spacing:var(--track-mid); color:var(--text-faint); margin-bottom:8px; }
.phdial-activecard { display:flex; align-items:center; gap:12px; border-color:var(--accent-dim); background:linear-gradient(135deg, var(--surface) 0%, var(--surface-strong) 100%); }
.phdial-activeicon { padding:7px; border-radius:10px; background:var(--accent-faint); border:1px solid var(--accent-dim); flex-shrink:0; }
.phdial-activetext { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.phdial-activetitle { color:var(--text); font-size:12px; font-weight:500; }
.phdial-activesub { color:var(--text-muted); font-size:10px; }
.phdial-pill { all:unset; cursor:pointer; height:26px; padding:0 11px; border-radius:var(--radius-xs); border:1px solid var(--accent-dim); color:var(--accent); font-family:var(--font-display); font-size:9px; letter-spacing:0.6px; white-space:nowrap; transition:background var(--dur-fast) ease; }
.phdial-pill:hover { background:var(--accent-dim); }
.phdial-pill.danger { border-color:var(--danger); color:var(--danger); }
.phdial-pill.danger:hover { background:var(--danger-dim); }
.phdial-transcript-body { display:flex; flex-direction:column; gap:5px; max-height:180px; overflow:auto; font-family:var(--font-mono); font-size:11px; }
.phdial-tline { color:var(--text-muted); line-height:1.5; word-break:break-word; }
.phdial-tline.agent { color:var(--accent-bright); }
.phdial-tspeaker { color:var(--text-faint); }
.phdial-empty { color:var(--text-faint); font-size:12px; padding:4px 0; }
.phdial-error { color:var(--danger); font-size:12px; padding:4px 0; }
.phdial-rows { display:flex; flex-direction:column; gap:7px; }
.phdial-row { display:flex; align-items:center; gap:10px; background:var(--surface-strong); border:1px solid var(--hairline-faint); border-radius:var(--radius-sm); padding:9px 11px; animation:phdial-row-in var(--dur-slow) ease-out backwards; transition:border-color var(--dur-fast) ease; }
.phdial-row.active { border-color:var(--accent-dim); }
@keyframes phdial-row-in { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
.phdial-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; box-shadow:0 0 6px currentColor; }
.phdial-dot.pulsing { animation:phdial-dot-pulse 900ms ease-in-out infinite; }
@keyframes phdial-dot-pulse { 0%, 100% { opacity:1; } 50% { opacity:0.3; } }
.phdial-row-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.phdial-row-title { color:var(--text); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.phdial-row-meta { color:var(--text-faint); font-family:var(--font-mono); font-size:9.5px; }
.phdial-extcard { display:flex; flex-direction:column; gap:8px; }
.phdial-modetoggle { display:flex; gap:8px; margin-bottom:2px; }
.phdial-modebtn { all:unset; cursor:pointer; height:24px; padding:0 12px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); color:var(--text-muted); font-family:var(--font-display); font-size:9px; letter-spacing:0.6px; }
.phdial-modebtn.on { border-color:var(--accent); color:var(--accent-bright); background:var(--accent-dim); }
.phdial-input { width:100%; height:32px; background:var(--surface-input); border:1px solid var(--hairline-soft); border-radius:var(--radius-xs); color:var(--text); padding:0 10px; font-family:var(--font-sans); font-size:12px; box-sizing:border-box; }
.phdial-input:focus { outline:none; border-color:var(--accent-dim); }
.phdial-extbtn { all:unset; cursor:pointer; text-align:center; height:34px; border-radius:var(--radius-xs); background:var(--accent-dim); color:var(--accent-bright); font-family:var(--font-display); font-size:11px; letter-spacing:var(--track-mid); font-weight:600; margin-top:2px; transition:background var(--dur-fast) ease; }
.phdial-extbtn:hover:not(:disabled) { background:var(--accent-faint); }
.phdial-extbtn:disabled { opacity:0.5; cursor:default; }
`
