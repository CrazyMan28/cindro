// Settings — full GUI SettingsPage parity, master-detail terminal edition.
// Left: section list. Right: rows (↑↓ + Enter activates; Esc backs out).
// Row kinds: enum knobs cycle-and-save immediately (settings.set {patch})
// like the legacy SettingsPane; text rows open the bottom input (secret rows
// masked + write-only); actions run verbs. Every daemon param name in here
// was verified against SettingsPage.qml / ControlServer.cpp — nothing is
// guessed (api_keys map patch, claude_account pro|max, desktop_pin ""-to-
// clear, voice.*_clone shapes, update.check/apply, extension/devices/
// connectors/policy verbs).

import type { InputRenderable, KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"

type Setting = Record<string, unknown>

interface RowSpec {
  id: string
  label: string
  kind: "enum" | "toggle" | "text" | "secret" | "action" | "info"
  value?: string
  choices?: string[]
  hint?: string
  run?: (input?: string) => Promise<string | void>
}

const SECTIONS = [
  "IDENTITY",
  "DEFAULTS",
  "MODE & AUTONOMY",
  "VOICE",
  "VIDEO",
  "API KEYS",
  "SECURITY",
  "TRUST POLICIES",
  "UPDATES",
  "CONNECTORS",
  "EXTENSION",
  "DEVICES",
] as const

const API_PROVIDERS = [
  "codex",
  "claude",
  "openai",
  "anthropic",
  "mistral",
  "ollama",
  "gemini",
  "xai",
  "deepseek",
]

const KNOBS: Array<{ id: string; label: string; choices: string[] }> = [
  { id: "agent_mode", label: "Agent mode", choices: ["coworker", "plan", "build"] },
  { id: "permission_level", label: "Permissions", choices: ["cautious", "balanced", "autonomous"] },
  { id: "self_improve", label: "Self-improve", choices: ["off", "on"] },
  { id: "auto_continue", label: "Auto-continue", choices: ["off", "capped", "on"] },
  { id: "wake_notify", label: "Wake notify", choices: ["silent", "ping", "always"] },
  { id: "skill_archive_days", label: "Skill archive after (days)", choices: ["0", "14", "30", "90"] },
  { id: "api_context_max_tokens", label: "API context compression", choices: ["0", "50000", "100000"] },
]

// Video understanding (video_* daemon keys — verified against SettingsStore.cpp
// videoDefaults()/normalizeVideoValue; the yt-dlp/ffmpeg/whisper pipeline runs in
// the Python engine and reads these live). Advanced chunking knobs stay chat-only
// via the video_configure tool.
const VIDEO_KNOBS: Array<{ id: string; label: string; choices: string[] }> = [
  { id: "video_backend", label: "Audio backend", choices: ["local", "gemini-api", "openai-api"] },
  { id: "video_whisper_engine", label: "Local engine", choices: ["faster-whisper", "whisper-cpp", "openai-whisper"] },
  { id: "video_whisper_model", label: "Whisper model", choices: ["auto", "tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"] },
  { id: "video_whisper_device", label: "Device", choices: ["auto", "cpu", "cuda"] },
  { id: "video_frame_mode", label: "Frame mode", choices: ["images", "descriptions"] },
  { id: "video_frame_format", label: "Frame format", choices: ["jpeg", "png", "webp"] },
  { id: "video_frame_resolution", label: "Frame resolution (px)", choices: ["256", "512", "768", "1024"] },
  { id: "video_default_fps", label: "Default fps", choices: ["auto", "0.2", "0.5", "1", "2"] },
  { id: "video_max_frames", label: "Max frames per call", choices: ["50", "100", "200"] },
  { id: "video_enable_index", label: "Cache frames on disk", choices: ["off", "on"] },
  { id: "video_session_max_age_days", label: "Cache expiry (days)", choices: ["3", "7", "30"] },
  { id: "video_downloads_max_age_days", label: "Downloads expiry (days)", choices: ["3", "7", "30"] },
]

/** qrencode -t ANSIUTF8 when available, else the raw pairing text. */
function asciiQr(text: string): string {
  try {
    const proc = Bun.spawnSync(["qrencode", "-t", "ANSIUTF8", text])
    if (proc.exitCode === 0) return proc.stdout.toString()
  } catch {
    // qrencode not installed — code text below still pairs fine
  }
  return ""
}

export function SettingsPage(props: { active: () => boolean }) {
  const app = useApp()
  const [settings, setSettings] = createSignal<Setting>({})
  const [section, setSection] = createSignal<number>(0)
  const [inDetail, setInDetail] = createSignal(false)
  const [rowSel, setRowSel] = createSignal(0)
  const [rows, setRows] = createSignal<RowSpec[]>([])
  const [status, setStatus] = createSignal("")
  const [inputRow, setInputRow] = createSignal<RowSpec | null>(null)
  const [blob, setBlob] = createSignal("") // QR / multi-line output area
  let inputRef: InputRenderable | undefined

  const s = () => settings()
  const str = (k: string) => String(s()[k] ?? "")
  const flag = (k: string) => (s()[k] === true ? "on" : "off")

  const reload = async () => {
    try {
      const res = await app.client.call("settings.get", {}, 8000)
      setSettings((res.settings ?? res) as Setting)
    } catch (e) {
      setStatus(`settings.get failed: ${String(e)}`)
    }
  }

  const patch = async (p: Record<string, unknown>, label = "saved") => {
    try {
      await app.client.call("settings.set", { patch: p })
      setStatus(`✓ ${label}`)
      await reload()
      await buildRows()
    } catch (e) {
      setStatus(`✕ ${String(e)}`)
    }
  }

  onMount(() => void reload())

  const buildRows = async (): Promise<void> => {
    const name = SECTIONS[section()]
    setBlob("")
    switch (name) {
      case "IDENTITY":
        setRows([
          {
            id: "assistant_name", label: "Assistant name", kind: "text",
            value: str("assistant_name"),
            run: async (v) => void (await patch({ assistant_name: v }, "assistant name")),
          },
          {
            id: "user_name", label: "Your name", kind: "text", value: str("user_name"),
            run: async (v) => void (await patch({ user_name: v }, "your name")),
          },
        ])
        return
      case "DEFAULTS": {
        const brains = ((s().brains ?? ["codex", "claude", "api"]) as unknown[]).map(String)
        const models = async () => {
          const res = await app.client.call("model.list", {}, 8000)
          return ((res.models ?? []) as unknown[]).map(String)
        }
        const accounts = (s().claude_accounts ?? []) as Array<Setting>
        const base: RowSpec[] = [
          {
            id: "default_brain", label: "Default brain", kind: "enum",
            value: str("default_brain"), choices: brains,
            run: async () => {
              const cur = str("default_brain")
              const next = brains[(brains.indexOf(cur) + 1) % brains.length]
              await patch({ default_brain: next }, `brain: ${next}`)
            },
          },
          {
            id: "default_model", label: "Default model", kind: "enum",
            value: str("default_model"),
            run: async () => {
              const list = await models()
              if (!list.length) {
                setStatus("no models reported")
                return
              }
              const next = list[(list.indexOf(str("default_model")) + 1) % list.length]
              await patch({ default_model: next }, `model: ${next}`)
            },
          },
        ]
        if (accounts.length) {
          base.push({
            id: "claude_account", label: "Claude account", kind: "enum",
            value: str("claude_account") || "pro", choices: ["pro", "max"],
            run: async () => {
              const next = (str("claude_account") || "pro") === "pro" ? "max" : "pro"
              await patch({ claude_account: next }, `claude account: ${next}`)
            },
          })
        }
        setRows(base)
        return
      }
      case "MODE & AUTONOMY":
        setRows(
          KNOBS.map((k) => ({
            id: k.id, label: k.label, kind: "enum" as const,
            value: str(k.id) || (s()[k.id] === true ? "on" : s()[k.id] === false ? "off" : ""),
            choices: k.choices,
            run: async () => {
              const raw = s()[k.id]
              const cur =
                typeof raw === "boolean" ? (raw ? "on" : "off") : String(raw ?? k.choices[0])
              const next = k.choices[(k.choices.indexOf(cur) + 1) % k.choices.length]
              const val =
                next === "on" ? true : next === "off" ? false : /^\d+$/.test(next) ? Number(next) : next
              await patch({ [k.id]: val }, `${k.label}: ${next}`)
            },
          })),
        )
        return
      case "VIDEO": {
        // Availability from settings.get's video_backends [{id,label,available}]
        // so cloud backends read as "needs API key" until one is set.
        const backends = ((s().video_backends ?? []) as Array<Setting>).map((b) => ({
          id: String(b.id ?? ""),
          available: b.available === true,
        }))
        const availability = (id: string) => {
          const b = backends.find((x) => x.id === id)
          return b && !b.available ? " (needs API key)" : ""
        }
        setRows([
          ...VIDEO_KNOBS.map((k) => ({
            id: k.id, label: k.label, kind: "enum" as const,
            value:
              (str(k.id) || (s()[k.id] === true ? "on" : s()[k.id] === false ? "off" : "")) +
              (k.id === "video_backend" ? availability(str(k.id)) : ""),
            choices: k.choices,
            run: async () => {
              const raw = s()[k.id]
              const cur =
                typeof raw === "boolean" ? (raw ? "on" : "off") : String(raw ?? k.choices[0])
              const next = k.choices[(k.choices.indexOf(cur) + 1) % k.choices.length]
              const val =
                next === "on" ? true : next === "off" ? false : /^\d+$/.test(next) ? Number(next) : next
              await patch({ [k.id]: val }, `${k.label}: ${next}`)
            },
          })),
          {
            id: "video_hint", label: "  ↳ paste a YouTube URL in chat to use this", kind: "action",
            hint: "Say “run video_setup” in chat for a live dependency + model check; “clear the video cache” clears cached frames.",
            run: async () => "ask Jarvis: run video_setup",
          },
        ])
        return
      }
      case "VOICE": {
        const sttChoices = ((s().stt_providers ?? []) as unknown[]).map(String)
        const ttsChoices = ((s().tts_providers ?? []) as unknown[]).map(String)
        const rowsOut: RowSpec[] = [
          {
            id: "stt_provider", label: "STT provider", kind: "enum",
            value: str("stt_provider"), choices: sttChoices,
            run: async () => {
              if (!sttChoices.length) return setStatus("no stt providers reported")
              const next =
                sttChoices[(sttChoices.indexOf(str("stt_provider")) + 1) % sttChoices.length]
              await patch({ stt_provider: next }, `stt: ${next}`)
            },
          },
          {
            id: "tts_provider", label: "TTS provider", kind: "enum",
            value: str("tts_provider"), choices: ttsChoices,
            run: async () => {
              if (!ttsChoices.length) return setStatus("no tts providers reported")
              const next =
                ttsChoices[(ttsChoices.indexOf(str("tts_provider")) + 1) % ttsChoices.length]
              await patch({ tts_provider: next }, `tts: ${next}`)
            },
          },
        ]
        try {
          const res = await app.client.call("voice.list_voices", {}, 8000)
          const voices = ((res.voices ?? []) as Array<Setting>).map((v) => ({
            id: String(v.id ?? ""),
            label: String(v.label ?? v.id ?? ""),
          }))
          rowsOut.push({
            id: "tts_voice", label: "Default voice", kind: "enum", value: str("tts_voice"),
            run: async () => {
              if (!voices.length) return setStatus("no voices reported")
              const ids = voices.map((v) => v.id)
              const next = ids[(ids.indexOf(str("tts_voice")) + 1) % ids.length]
              await patch({ tts_voice: next }, `voice: ${next}`)
            },
          })
          for (const v of voices) {
            rowsOut.push({
              id: `voice:${v.id}`, label: `  🗣 ${v.label}`, kind: "action",
              hint: "Enter: preview · (rename/delete via the actions below)",
              run: async () => {
                await app.client.call("voice.preview_clone", {
                  id: v.id,
                  text: "Jarvis voice preview — all systems nominal.",
                })
                return `previewing ${v.label}`
              },
            })
          }
          rowsOut.push({
            id: "voice_set_default", label: "Set selected voice as default", kind: "text",
            hint: "type a voice id",
            run: async (id) => {
              await app.client.call("voice.set_default", { id })
              await reload()
              return `default voice: ${id}`
            },
          })
          rowsOut.push({
            id: "voice_delete", label: "Delete a cloned voice", kind: "text",
            hint: "type a voice id (destructive)",
            run: async (id) => {
              await app.client.call("voice.delete_clone", { id })
              await buildRows()
              return `deleted ${id}`
            },
          })
        } catch (e) {
          rowsOut.push({ id: "verr", label: `voices unavailable: ${String(e)}`, kind: "info" })
        }
        setRows(rowsOut)
        return
      }
      case "API KEYS": {
        const set = (s().api_keys_set ?? {}) as Record<string, unknown>
        setRows(
          API_PROVIDERS.map((p) => ({
            id: `key:${p}`, label: `${p}${set[p] ? "  [saved]" : "  [empty]"}`,
            kind: "secret" as const,
            hint: "Enter: set key (empty input clears)",
            run: async (v) => {
              await patch({ api_keys: { [p]: v ?? "" } }, v ? `${p} key saved` : `${p} key cleared`)
            },
          })),
        )
        return
      }
      case "SECURITY":
        setRows([
          {
            id: "auth_lock_enabled", label: "Phone + fingerprint unlock", kind: "enum",
            value: flag("auth_lock_enabled"), choices: ["off", "on"],
            run: async () =>
              void (await patch(
                { auth_lock_enabled: s().auth_lock_enabled !== true },
                "auth lock",
              )),
          },
          {
            id: "desktop_pin",
            label: `Desktop unlock PIN ${s().has_desktop_pin ? "[set]" : "[not set]"}`,
            kind: "secret", hint: "Enter: set PIN (empty input clears it)",
            run: async (v) => void (await patch({ desktop_pin: v ?? "" }, v ? "PIN set" : "PIN cleared")),
          },
        ])
        return
      case "TRUST POLICIES": {
        try {
          const res = await app.client.call("policy.list", {}, 8000)
          const rules = (res.rules ?? res.policies ?? []) as Array<Setting>
          const def = String(res.default_action ?? "ask")
          const cycle = ["allow", "ask", "deny"]
          const out: RowSpec[] = [
            {
              id: "policy_default", label: "Default action", kind: "enum", value: def,
              choices: cycle,
              run: async () => {
                const next = cycle[(cycle.indexOf(def) + 1) % cycle.length]
                await app.client.call("policy.set_default", { action: next })
                await buildRows()
                return `default: ${next}`
              },
            },
          ]
          for (const r of rules) {
            const id = String(r.id ?? "")
            const action = String(r.action ?? "ask")
            out.push({
              id: `rule:${id}`,
              label: `  ${String(r.tool ?? "*")} / ${String(r.app ?? "*")} → ${action}`,
              kind: "action", hint: "Enter: cycle action · type 'del <id>' below to remove",
              run: async () => {
                const next = cycle[(cycle.indexOf(action) + 1) % cycle.length]
                await app.client.call("policy.update", { id, action: next })
                await buildRows()
                return `${id} → ${next}`
              },
            })
          }
          out.push({
            id: "policy_add", label: "Add rule", kind: "text",
            hint: "tool-glob :: app-glob :: allow|ask|deny :: note",
            run: async (v) => {
              const [tool = "*", appGlob = "*", action = "ask", note = ""] = (v ?? "")
                .split("::")
                .map((x) => x.trim())
              await app.client.call("policy.add", { tool, app: appGlob, action, note })
              await buildRows()
              return "rule added"
            },
          })
          out.push({
            id: "policy_remove", label: "Remove rule", kind: "text", hint: "rule id",
            run: async (v) => {
              await app.client.call("policy.remove", { id: v ?? "" })
              await buildRows()
              return "rule removed"
            },
          })
          setRows(out)
        } catch (e) {
          setRows([{ id: "perr", label: `policies unavailable: ${String(e)}`, kind: "info" }])
        }
        return
      }
      case "UPDATES":
        setRows([
          {
            id: "auto_update", label: "Auto-update", kind: "enum",
            value: flag("auto_update"), choices: ["off", "on"],
            run: async () =>
              void (await patch({ auto_update: s().auto_update !== true }, "auto-update")),
          },
          {
            id: "auto_update_apply", label: "Auto-install updates", kind: "enum",
            value: flag("auto_update_apply"), choices: ["off", "on"],
            run: async () =>
              void (await patch(
                { auto_update_apply: s().auto_update_apply !== true },
                "auto-install",
              )),
          },
          {
            id: "update_check", label: "Check for updates now", kind: "action",
            run: async () => {
              const res = await app.client.call("update.check", {}, 30000)
              return res.available
                ? `update available: ${String(res.version ?? "?")} — run "Install update now"`
                : "already up to date"
            },
          },
          {
            id: "update_apply", label: "Install update now", kind: "action",
            run: async () => {
              const res = await app.client.call("update.apply", {}, 120000)
              return String(res.message ?? "update started (daemon restarts itself)")
            },
          },
          { id: "version", label: `Version: v${str("version")} (${str("git_sha")})`, kind: "info" },
        ])
        return
      case "CONNECTORS": {
        try {
          const res = await app.client.call("connectors.list", {}, 8000)
          const connectors = (res.connectors ?? []) as Array<Setting>
          const out: RowSpec[] = connectors.map((c) => ({
            id: `conn:${String(c.id)}`,
            label: `  ${String(c.service)} — ${c.enabled ? "enabled" : "disabled"} · creds: ${
              c.has_client_id && c.has_client_secret && c.has_refresh_token ? "complete" : "incomplete"
            }`,
            kind: "info" as const,
          }))
          out.push({
            id: "conn_add", label: "Add Google connector", kind: "text",
            hint: "service :: client_id :: client_secret :: refresh_token",
            run: async (v) => {
              const [service = "", clientId = "", clientSecret = "", refreshToken = ""] = (v ?? "")
                .split("::")
                .map((x) => x.trim())
              await app.client.call("connectors.add", {
                service,
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
              })
              await buildRows()
              return `connector ${service} saved`
            },
          })
          setRows(out)
        } catch (e) {
          setRows([{ id: "cerr", label: `connectors unavailable: ${String(e)}`, kind: "info" }])
        }
        return
      }
      case "EXTENSION":
        setRows([
          {
            id: "ext_pair", label: "Generate browser-extension pairing code", kind: "action",
            run: async () => {
              const res = await app.client.call("extension.pair_start", {}, 15000)
              const code = String(res.code ?? res.pairing_code ?? "")
              setBlob(asciiQr(code))
              return `pairing code: ${code}`
            },
          },
        ])
        return
      case "DEVICES": {
        try {
          const res = await app.client.call("devices.list", {}, 8000)
          const devices = (res.devices ?? []) as Array<Setting>
          const out: RowSpec[] = devices.map((d) => ({
            id: `dev:${String(d.id)}`,
            label: `  📱 ${String(d.name ?? d.id)} · paired ${String(d.paired_at ?? "")}`,
            kind: "info" as const,
          }))
          out.push({
            id: "dev_pair", label: "Pair a new phone", kind: "action",
            run: async () => {
              const r = await app.client.call("devices.pair_start", {}, 15000)
              const code = String(r.code ?? r.pairing_code ?? "")
              const url = String(r.url ?? "")
              setBlob(asciiQr(url || code))
              return `pairing code: ${code}${url ? ` · ${url}` : ""}`
            },
          })
          out.push({
            id: "dev_revoke", label: "Revoke a device", kind: "text", hint: "device id",
            run: async (v) => {
              await app.client.call("devices.revoke", { id: v ?? "" })
              await buildRows()
              return "device revoked"
            },
          })
          setRows(out)
        } catch (e) {
          setRows([{ id: "derr", label: `devices unavailable: ${String(e)}`, kind: "info" }])
        }
        return
      }
      default:
        setRows([])
    }
  }

  const activateRow = (row: RowSpec) => {
    if (row.kind === "text" || row.kind === "secret") {
      setInputRow(row)
      queueMicrotask(() => inputRef?.focus())
      return
    }
    if (row.run) {
      void row.run()
        .then((msg) => {
          if (msg) setStatus(String(msg))
        })
        .catch((e) => setStatus(`✕ ${String(e)}`))
    }
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active()) return
      if (inputRow()) {
        if (key.name === "escape") {
          key.preventDefault()
          setInputRow(null)
        }
        return
      }
      if (!inDetail()) {
        switch (key.name) {
          case "up":
            setSection((i) => Math.max(0, i - 1))
            break
          case "down":
            setSection((i) => Math.min(SECTIONS.length - 1, i + 1))
            break
          case "return":
            setRowSel(0)
            setInDetail(true)
            void buildRows()
            break
          default:
            break
        }
        return
      }
      switch (key.name) {
        case "escape":
          key.preventDefault()
          setInDetail(false)
          setBlob("")
          break
        case "up":
          setRowSel((i) => Math.max(0, i - 1))
          break
        case "down":
          setRowSel((i) => Math.min(Math.max(0, rows().length - 1), i + 1))
          break
        case "return": {
          const row = rows()[rowSel()]
          if (row) activateRow(row)
          break
        }
        case "r":
          void reload().then(buildRows)
          break
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="row" flexGrow={1} paddingLeft={1} paddingRight={1} gap={2}>
      <box flexDirection="column" minWidth={22} flexShrink={0}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          // SETTINGS
        </text>
        <For each={[...SECTIONS]}>
          {(name, i) => (
            <text
              fg={
                i() === section()
                  ? inDetail()
                    ? theme.accent
                    : theme.accentBright
                  : theme.textMuted
              }
              attributes={i() === section() ? TextAttributes.BOLD : undefined}
              selectable={false}
              onMouseDown={() => {
                setSection(i())
                setRowSel(0)
                setInDetail(true)
                void buildRows()
              }}
            >
              {i() === section() ? "▸ " : "  "}
              {name}
            </text>
          )}
        </For>
        <text fg={theme.textFaint} selectable={false}>
          {inDetail() ? "Esc back · r reload" : "↑↓ section · Enter open"}
        </text>
      </box>

      <box flexDirection="column" flexGrow={1}>
        <Show
          when={inDetail()}
          fallback={<text fg={theme.textFaint}>pick a section — every value saves instantly</text>}
        >
          <scrollbox flexGrow={1}>
            <For each={rows()} fallback={<text fg={theme.textFaint}>(loading…)</text>}>
              {(row, i) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text
                    fg={i() === rowSel() ? theme.accentBright : theme.text}
                    attributes={i() === rowSel() ? TextAttributes.BOLD : undefined}
                    selectable={false}
                    onMouseDown={() => {
                      setRowSel(i())
                      activateRow(row)
                    }}
                  >
                    {row.label}
                  </text>
                  <Show when={row.kind === "enum" && row.value !== undefined}>
                    <text fg={theme.amber} selectable={false}>
                      ⟨{row.value || "unset"}⟩
                    </text>
                  </Show>
                  <Show when={i() === rowSel() && row.hint}>
                    <text fg={theme.textFaint} selectable={false}>
                      {row.hint}
                    </text>
                  </Show>
                </box>
              )}
            </For>
            <Show when={blob()}>
              <text fg={theme.text}>{blob()}</text>
            </Show>
          </scrollbox>
        </Show>
        <Show when={status()}>
          <text fg={theme.textMuted} selectable={false}>
            {status()}
          </text>
        </Show>
        <Show when={inputRow()}>
          {(row) => (
            <box flexDirection="row" height={3} flexShrink={0} border borderColor={theme.accent}>
              <text fg={theme.accent} selectable={false}>
                {row().label.trim()}:{" "}
              </text>
              <input
                ref={(r: InputRenderable) => {
                  inputRef = r
                }}
                flexGrow={1}
                placeholder={row().hint ?? ""}
                onSubmit={(v: unknown) => {
                  const pending = row()
                  setInputRow(null)
                  const text = typeof v === "string" ? v : ""
                  void pending
                    .run?.(text)
                    .then((msg) => {
                      if (msg) setStatus(String(msg))
                    })
                    .catch((e) => setStatus(`✕ ${String(e)}`))
                }}
              />
            </box>
          )}
        </Show>
      </box>
    </box>
  )
}
