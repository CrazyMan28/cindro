// AGENTS tab body — ported from desktop/qml/PhoneAgentsTab.qml: roster via
// list_extensions (list_agents fallback), CALL button, and a per-agent
// CONFIG panel (voice grouped-by-speaker + emotion chips + preview,
// speaking-rate slider 0.5x-2x, model chips, thinking-effort chips), each
// change saved immediately over phone.http — mirrors
// tui/src/phone/tabs/AgentsTab.tsx's confirmed REST shapes for a non-Qt
// client (GET/PUT /api/extensions/<ext>/voice|model, GET /api/voices).
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { ControlClient } from "../../core/control-client"
import { PhoneTabPanel, usePhoneTab } from "./index"

// -- local phone.mcp / phone.http wrappers — see dialer.tsx's matching
// header comment for why this is a small self-contained copy rather than a
// shared pages/phone/api.ts (this unit only owns these two files). --------
interface PhoneErr {
  code: string
  message: string
}
interface McpRes {
  tool?: string
  data?: unknown
  error?: PhoneErr
}
interface HttpRes {
  status?: number
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

async function phoneHttp(client: ControlClient, method: string, path: string, body: Row = {}): Promise<HttpRes> {
  try {
    return (await client.call("phone.http", { method, path, body }, 30000)) as HttpRes
  } catch (e) {
    return { status: 0, error: { code: "transport_error", message: String(e) } }
  }
}

/** Failure message for an http result, or null when it succeeded — a >=400
 * status is always a failure here (tui/src/phone/api.ts's httpFailure). */
function httpFailure(res: HttpRes): string | null {
  if (res.error) return res.error.message
  const status = res.status ?? 0
  if (status >= 400 || status === 0) {
    const data = (res.data ?? {}) as Row
    return String(data.error ?? data.message ?? `HTTP ${status}`)
  }
  return null
}

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

function asList(data: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(data)) return data as Row[]
  if (typeof data === "object" && data !== null) {
    for (const k of keys) {
      const v = (data as Row)[k]
      if (Array.isArray(v)) return v as Row[]
    }
  }
  return []
}

interface AgentRow {
  ext: string
  name: string
  status: string
  task: string
}

function toAgentRow(a: Row, i: number): AgentRow {
  return {
    ext: str(a.extension) || str(a.ext),
    name: a.name !== undefined ? str(a.name) : `Agent ${i}`,
    status: str(a.status, "offline"),
    task: str(a.current_task),
  }
}

interface VoiceEntry {
  vid: string
  vname: string
  speaker: string
  emotion: string
}

/** Built-in fallback voice set when GET /api/voices is empty — verbatim
 * from PhoneAgentsTab.qml:121-138 (matches the agent-phone Android app). */
const DEFAULT_VOICES: VoiceEntry[] = [
  { vid: "", vname: "Default", speaker: "Default", emotion: "Default" },
  { vid: "jarvis-od", vname: "Cindro (on-device)", speaker: "Cindro", emotion: "Cindro" },
  { vid: "paul-cheerful", vname: "Paul - Cheerful", speaker: "Paul", emotion: "Cheerful" },
  { vid: "paul-sad", vname: "Paul - Sad", speaker: "Paul", emotion: "Sad" },
  { vid: "paul-angry", vname: "Paul - Angry", speaker: "Paul", emotion: "Angry" },
  { vid: "paul-terrified", vname: "Paul - Terrified", speaker: "Paul", emotion: "Terrified" },
  { vid: "paul-shouting", vname: "Paul - Shouting", speaker: "Paul", emotion: "Shouting" },
  { vid: "oliver-cheerful", vname: "Oliver - Cheerful", speaker: "Oliver", emotion: "Cheerful" },
  { vid: "oliver-sad", vname: "Oliver - Sad", speaker: "Oliver", emotion: "Sad" },
  { vid: "oliver-friendly", vname: "Oliver - Friendly", speaker: "Oliver", emotion: "Friendly" },
  { vid: "jane-cheerful", vname: "Jane - Cheerful", speaker: "Jane", emotion: "Cheerful" },
  { vid: "jane-sad", vname: "Jane - Sad", speaker: "Jane", emotion: "Sad" },
  { vid: "jane-friendly", vname: "Jane - Friendly", speaker: "Jane", emotion: "Friendly" },
  { vid: "marie-cheerful", vname: "Marie - Cheerful", speaker: "Marie", emotion: "Cheerful" },
  { vid: "marie-sad", vname: "Marie - Sad", speaker: "Marie", emotion: "Sad" },
  { vid: "marie-friendly", vname: "Marie - Friendly", speaker: "Marie", emotion: "Friendly" },
]

/** Speaker/emotion split for server voices (PhoneAgentsTab.qml:114-117). */
function parseVoice(v: Row, index: number): VoiceEntry {
  const nm = str(v.label) || str(v.name) || `Voice ${index}`
  const dash = nm.includes(" - ")
  const speaker = str(v.speaker) || (dash ? nm.split(" - ")[0].trim() : nm.replace(/ *\(.*\)/, "").trim())
  const emotion = str(v.emotion) || (dash ? nm.split(" - ")[1].trim() : "Default")
  return { vid: str(v.id), vname: nm, speaker, emotion }
}

// Which daemon brain (if any) an agent's model picker should query via
// model.list — codex/claude only; other extensions (Copilot, Echo, Hermes,
// Mistral Screener, ...) have no selectable Jarvis-brain model. Mirrors
// android AgentConfigScreen.kt / tui/src/phone/api.ts / extension/sidepanel.js's
// equivalents — keep all four in sync if the naming convention changes.
function brainForAgent(name: string): string | null {
  const n = name.toLowerCase()
  if (n.includes("claude")) return "claude"
  if (n.includes("codex")) return "codex"
  return null
}
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"]

export function PhoneAgentsTab() {
  const app = useApp()
  const ctx = usePhoneTab()

  const [agents, setAgents] = createSignal<AgentRow[]>([])
  const [listLoading, setListLoading] = createSignal(true)
  const [listError, setListError] = createSignal("")
  const [callStatus, setCallStatus] = createSignal("")

  // config panel state (PhoneAgentsTab.qml:52-60)
  const [cfg, setCfg] = createSignal<{ ext: string; name: string } | null>(null)
  const [voices, setVoices] = createSignal<VoiceEntry[]>([])
  const [voiceId, setVoiceId] = createSignal("")
  const [voiceName, setVoiceName] = createSignal("(default)")
  const [speed, setSpeed] = createSignal(1.0)
  const [model, setModel] = createSignal("")
  const [models, setModels] = createSignal<string[]>([])
  const [thinking, setThinking] = createSignal("low")
  const [cfgStatus, setCfgStatus] = createSignal("")

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const populate = (data: unknown) => {
    if (!alive) return
    setAgents(asList(data).map(toAgentRow))
  }

  const refresh = async () => {
    setListLoading(true)
    setListError("")
    const res = await phoneMcp(app.client, "list_extensions")
    if (!alive) return
    if (!res.error) {
      populate(res.data)
      setListLoading(false)
      return
    }
    const res2 = await phoneMcp(app.client, "list_agents")
    if (!alive) return
    setListLoading(false)
    if (res2.error) {
      setListError(res2.error.message || "Could not load agents.")
      return
    }
    populate(res2.data)
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    onCleanup(() => clearInterval(timer))
  })

  // Shell's refresh (↺) button re-fires this tab's data load without a full
  // remount — mirrors the contract note in phone/index.tsx.
  createEffect(on(ctx.refreshNonce, () => void refresh(), { defer: true }))

  const openConfig = async (agent: AgentRow) => {
    setCfg({ ext: agent.ext, name: agent.name })
    setVoiceId("")
    setVoiceName("(default)")
    setSpeed(1.0)
    setModel("")
    setModels([])
    setThinking("low")
    setCfgStatus("Loading…")

    const vres = await phoneHttp(app.client, "GET", "/api/voices")
    if (!alive) return
    const vfail = httpFailure(vres)
    const raw = vfail ? [] : asList(vres.data, "voices")
    // Skip clones from /api/voices — they come from the VoiceLibrary below as a
    // dedicated "Your voices" group (avoids duplicates).
    const catalog = raw
      .filter((v) => {
        const id = str(v.id)
        return id.indexOf("clone:") !== 0 && id !== "jarvice"
      })
      .map((v, i) => parseVoice(v, i))
    // The user's NAMED cloned voices (Settings → Voice / VoiceLibrary), merged in
    // FIRST so an agent (e.g. ext 101) can speak on calls with a clone:<slug>.
    let clones: VoiceEntry[] = []
    try {
      const lv = (await app.client.call("voice.list_voices", {}, 15000)) as { voices?: Row[] }
      clones = (lv.voices ?? [])
        .filter((v) => v.custom === true && str(v.id))
        .map((v) => {
          const label = str(v.label) || str(v.id)
          return { vid: str(v.id), vname: label, speaker: "Your voices", emotion: label }
        })
    } catch {
      /* voice.list_voices unavailable — just show the catalog */
    }
    if (!alive) return
    const merged = [...clones, ...catalog]
    setVoices(merged.length > 0 ? merged : DEFAULT_VOICES)
    if (vfail) setCfgStatus(`voices: ${vfail} — using built-in list`)

    const pres = await phoneHttp(app.client, "GET", `/api/extensions/${agent.ext}/voice`)
    if (!alive) return
    const pfail = httpFailure(pres)
    if (!pfail && pres.data) {
      const d = (pres.data ?? {}) as Row
      setVoiceId(str(d.voice_id) || str(d.id))
      setVoiceName(str(d.voice_name) || str(d.name) || "(default)")
      if (d.speed !== undefined) setSpeed(Number(d.speed) || 1.0)
    } else if (pfail) {
      setCfgStatus(`voice profile: ${pfail}`)
    }

    // Live model ids for this agent's brain, same model.list RPC the main
    // Jarvis picker uses (chat.tsx) — replaces the old hardcoded MODEL_CHIPS,
    // which went stale the same way the main picker's used to before it was
    // wired to model.list.
    const brain = brainForAgent(agent.name)
    let modelIds: string[] = []
    if (brain) {
      try {
        const mlres = await app.client.call("model.list", { brain }, 8000)
        if (!alive) return
        modelIds = ((mlres.models ?? []) as unknown[]).map(String)
        setModels(modelIds)
      } catch {
        // leave modelIds/models empty — the MODEL section just won't render
      }
    }
    if (!alive) return

    const mres = await phoneHttp(app.client, "GET", `/api/extensions/${agent.ext}/model`)
    if (!alive) return
    const mfail = httpFailure(mres)
    if (!mfail && mres.data) {
      const d = (mres.data ?? {}) as Row
      setModel(str(d.model) || modelIds[0] || "")
      setThinking(str(d.reasoning) || str(d.thinking) || "low")
      setCfgStatus("")
    } else if (mfail) {
      setCfgStatus(`model config: ${mfail}`)
    } else {
      setCfgStatus("")
    }
  }

  const saveVoice = async (vid: string, vname: string) => {
    setVoiceId(vid)
    setVoiceName(vname)
    setCfgStatus("Saving…")
    const c = cfg()
    if (!c) return
    const res = await phoneHttp(app.client, "PUT", `/api/extensions/${c.ext}/voice`, { voice_id: vid, speed: speed() })
    if (!alive) return
    const fail = httpFailure(res)
    setCfgStatus(fail ? `Voice error: ${fail}` : "Voice saved.")
  }

  const commitSpeed = async (spd: number) => {
    const c = cfg()
    if (!c) return
    const res = await phoneHttp(app.client, "PUT", `/api/extensions/${c.ext}/voice`, { voice_id: voiceId(), speed: spd })
    if (!alive) return
    const fail = httpFailure(res)
    setCfgStatus(fail ? `Speed error: ${fail}` : "Speed saved.")
  }

  const saveModelConfig = async (m: string, th: string) => {
    if (m) setModel(m)
    if (th) setThinking(th)
    setCfgStatus("Saving model config…")
    const c = cfg()
    if (!c) return
    const res = await phoneHttp(app.client, "PUT", `/api/extensions/${c.ext}/model`, { model: model(), reasoning: thinking() })
    if (!alive) return
    const fail = httpFailure(res)
    setCfgStatus(fail ? `Model error: ${fail}` : "Model saved.")
  }

  const preview = async (vid: string) => {
    const target = vid || voiceId()
    if (!target) {
      setCfgStatus("No voice selected.")
      return
    }
    setCfgStatus("Previewing…")
    // GET /api/voices/<voiceId>/sample is an audio endpoint — like the QML
    // and TUI reference implementations, this surfaces status only (no
    // guaranteed JSON-safe audio payload over the phone.http proxy).
    const res = await phoneHttp(app.client, "GET", `/api/voices/${encodeURIComponent(target)}/sample`)
    if (!alive) return
    setCfgStatus(httpFailure(res) ? "Preview unavailable on this server." : "Playing preview…")
  }

  const callAgent = async (agent: AgentRow) => {
    setCallStatus(`Calling ${agent.name} (ext ${agent.ext})…`)
    const res = await phoneMcp(app.client, "call_extension", { extension: agent.ext })
    if (!alive) return
    setCallStatus(res.error ? `Error: ${res.error.message}` : `Ringing ext ${agent.ext}`)
  }

  const speakers = createMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of voices()) {
      if (!seen.has(v.speaker)) {
        seen.add(v.speaker)
        out.push(v.speaker)
      }
    }
    return out
  })

  return (
    <PhoneTabPanel>
      <style>{AGENTS_TAB_CSS}</style>
      <Show
        when={cfg()}
        fallback={
          <div class="phagt-list">
            <Show when={callStatus()}>
              <div class="phagt-status">{callStatus()}</div>
            </Show>
            <Show when={listError()}>
              <div class="phagt-error">⚠ {listError()}</div>
            </Show>
            <Show when={listLoading() && agents().length === 0}>
              <div class="phagt-empty">Loading agents…</div>
            </Show>
            <Show when={!listLoading() && !listError() && agents().length === 0}>
              <div class="phagt-empty">No agents registered.</div>
            </Show>
            <div class="phagt-rows">
              <For each={agents()}>
                {(a, i) => {
                  const enterDelay = Math.min(i() * 32, 260)
                  return (
                    <div class="phagt-row" style={{ "animation-delay": `${enterDelay}ms` }}>
                      <div class="phagt-avatar" classList={{ online: a.status === "online" }}>
                        🤖
                      </div>
                      <div class="phagt-row-main">
                        <div class="phagt-row-top">
                          <span class="phagt-name">{a.name}</span>
                          <span class="phagt-pill" classList={{ online: a.status === "online" }}>
                            {a.status.toUpperCase()}
                          </span>
                          <span class="phagt-ext">ext {a.ext}</span>
                        </div>
                        <div class="phagt-task">{a.task || "No current task"}</div>
                      </div>
                      <button
                        type="button"
                        class="phagt-callbtn"
                        classList={{ online: a.status === "online" }}
                        onClick={() => void callAgent(a)}
                      >
                        CALL
                      </button>
                      <button type="button" class="phagt-cfgbtn" onClick={() => void openConfig(a)}>
                        CONFIG
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        }
      >
        {(c) => (
          <div class="phagt-cfg">
            <div class="phagt-cfg-header">
              <button type="button" class="phagt-back" onClick={() => setCfg(null)} title="Back">
                ←
              </button>
              <div class="phagt-cfg-title">
                <div class="phagt-cfg-name">{c().name}</div>
                <div class="phagt-cfg-ext">Extension {c().ext}</div>
              </div>
              <button type="button" class="phagt-previewbtn" onClick={() => void preview(voiceId())}>
                ▶ PREVIEW
              </button>
            </div>

            <Show when={cfgStatus()}>
              <div class="phagt-cfgstatus" classList={{ error: cfgStatus().toLowerCase().includes("error") }}>
                {cfgStatus()}
              </div>
            </Show>

            <div class="phagt-section-title hud-label">VOICE</div>
            <div class="card phagt-voicecard">
              <div class="phagt-current">Current: {voiceName()}</div>
              <For each={speakers()}>
                {(sp) => (
                  <div class="phagt-speakerrow">
                    <span class="phagt-speakerlbl">{sp}</span>
                    <div class="phagt-emotionrow">
                      <For each={voices().filter((v) => v.speaker === sp)}>
                        {(v) => (
                          <button
                            type="button"
                            class="phagt-emochip"
                            classList={{ on: voiceId() === v.vid }}
                            onClick={() => void saveVoice(v.vid, v.vname)}
                          >
                            {v.emotion}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <div class="phagt-section-title hud-label">SPEAKING RATE</div>
            <div class="card phagt-ratecard">
              <div class="phagt-ratevalue">{Math.round(speed() * 100) / 100}×</div>
              <input
                class="phagt-slider"
                type="range"
                min="0.5"
                max="2.0"
                step="0.05"
                value={speed()}
                onInput={(e) => setSpeed(Number(e.currentTarget.value))}
                onChange={(e) => void commitSpeed(Number(e.currentTarget.value))}
              />
              <div class="phagt-ratehint">0.5× slow · 1× normal · 2× fast</div>
            </div>

            <Show when={models().length > 0}>
            <div class="phagt-section-title hud-label">MODEL</div>
            <div class="card phagt-modelcard">
              <div class="phagt-chiprow">
                <For each={models()}>
                  {(id) => (
                    <button
                      type="button"
                      class="phagt-chip"
                      classList={{ on: model() === id }}
                      onClick={() => void saveModelConfig(id, "")}
                    >
                      {id}
                    </button>
                  )}
                </For>
              </div>
              <div class="phagt-subtitle">Thinking</div>
              <div class="phagt-chiprow">
                <For each={THINKING_LEVELS}>
                  {(th) => (
                    <button
                      type="button"
                      class="phagt-chip"
                      classList={{ on: thinking() === th }}
                      onClick={() => void saveModelConfig("", th)}
                    >
                      {th}
                    </button>
                  )}
                </For>
              </div>
            </div>
            </Show>
          </div>
        )}
      </Show>
    </PhoneTabPanel>
  )
}

const AGENTS_TAB_CSS = `
.phagt-status { color:var(--accent); font-family:var(--font-mono); font-size:11px; }
.phagt-error { color:var(--danger); font-size:12px; }
.phagt-empty { color:var(--text-faint); font-size:12px; padding:8px 2px; }
.phagt-list { display:flex; flex-direction:column; gap:10px; }
.phagt-rows { display:flex; flex-direction:column; gap:8px; }
.phagt-row { display:flex; align-items:center; gap:12px; background:var(--surface); border:1px solid var(--hairline-soft); border-radius:var(--radius-sm); padding:12px 14px; transition:border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease, transform var(--dur-fast) ease; animation:phagt-row-in var(--dur-slow) ease-out backwards; }
.phagt-row:hover { border-color:var(--accent-dim); box-shadow:0 4px 18px -6px var(--accent-glow); transform:translateY(-1px); }
@keyframes phagt-row-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
.phagt-avatar { width:40px; height:40px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:18px; background:rgba(92,113,133,0.14); }
.phagt-avatar.online { background:rgba(57,230,160,0.16); }
.phagt-row-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.phagt-row-top { display:flex; align-items:center; gap:8px; }
.phagt-name { color:var(--text); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.phagt-pill { font-size:9px; font-family:var(--font-display); letter-spacing:0.5px; padding:2px 8px; border-radius:8px; background:var(--surface-strong); color:var(--text-muted); }
.phagt-pill.online { background:rgba(57,230,160,0.20); color:var(--success); }
.phagt-ext { color:var(--text-faint); font-family:var(--font-mono); font-size:10px; }
.phagt-task { color:var(--text-muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.phagt-callbtn { all:unset; cursor:pointer; height:28px; padding:0 14px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); color:var(--text-muted); font-family:var(--font-display); font-size:9px; letter-spacing:0.8px; transition:background var(--dur-fast) ease, color var(--dur-fast) ease, border-color var(--dur-fast) ease; }
.phagt-callbtn.online { border-color:var(--accent); color:var(--accent); background:var(--accent-dim); }
.phagt-callbtn:hover { background:var(--accent); color:var(--ink-on-accent); border-color:var(--accent); }
.phagt-cfgbtn { all:unset; cursor:pointer; height:28px; padding:0 14px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); color:var(--text-muted); font-family:var(--font-display); font-size:9px; letter-spacing:0.8px; transition:background var(--dur-fast) ease; }
.phagt-cfgbtn:hover { background:rgba(255,255,255,0.05); }
.phagt-cfg { display:flex; flex-direction:column; gap:12px; max-width:640px; }
.phagt-cfg-header { display:flex; align-items:center; gap:12px; }
.phagt-back { all:unset; cursor:pointer; width:30px; height:30px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); display:flex; align-items:center; justify-content:center; color:var(--text-muted); font-size:15px; flex-shrink:0; transition:background var(--dur-fast) ease; }
.phagt-back:hover { background:rgba(255,255,255,0.05); }
.phagt-cfg-title { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.phagt-cfg-name { color:var(--text); font-size:14px; font-weight:500; }
.phagt-cfg-ext { color:var(--text-faint); font-family:var(--font-mono); font-size:10px; }
.phagt-previewbtn { all:unset; cursor:pointer; height:30px; padding:0 14px; border-radius:var(--radius-xs); border:1px solid var(--accent-dim); color:var(--accent); font-family:var(--font-display); font-size:9px; letter-spacing:0.6px; white-space:nowrap; transition:background var(--dur-fast) ease; }
.phagt-previewbtn:hover { background:var(--accent-dim); }
.phagt-cfgstatus { color:var(--accent); font-family:var(--font-mono); font-size:10px; }
.phagt-cfgstatus.error { color:var(--danger); }
.phagt-section-title { font-size:9px; letter-spacing:2px; color:var(--text-faint); font-weight:600; }
.phagt-voicecard, .phagt-ratecard, .phagt-modelcard { display:flex; flex-direction:column; gap:10px; }
.phagt-current { color:var(--accent); font-size:11px; }
.phagt-speakerrow { display:flex; align-items:center; gap:8px; }
.phagt-speakerlbl { width:56px; flex-shrink:0; color:var(--text-faint); font-size:10px; }
.phagt-emotionrow { display:flex; flex-wrap:wrap; gap:6px; flex:1; min-width:0; overflow-x:auto; }
.phagt-emochip { all:unset; cursor:pointer; height:26px; padding:0 12px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); background:var(--surface-strong); color:var(--text-muted); font-size:11px; white-space:nowrap; transition:background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.phagt-emochip.on { border-color:var(--accent); color:var(--accent); background:var(--accent-dim); }
.phagt-emochip:hover { background:rgba(255,255,255,0.06); }
.phagt-ratevalue { color:var(--accent); font-family:var(--font-mono); font-size:14px; font-weight:500; }
.phagt-slider { width:100%; accent-color:var(--accent); cursor:pointer; }
.phagt-ratehint { color:var(--text-faint); font-size:10px; }
.phagt-chiprow { display:flex; flex-wrap:wrap; gap:8px; }
.phagt-chip { all:unset; cursor:pointer; height:28px; padding:0 14px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); background:var(--surface-strong); color:var(--text-muted); font-size:11px; transition:background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.phagt-chip.on { border-color:var(--accent); color:var(--accent); background:var(--accent-dim); }
.phagt-chip:hover { background:rgba(255,255,255,0.06); }
.phagt-subtitle { color:var(--text-faint); font-size:10px; }
`
