// <SetupWizard/> — first-launch onboarding overlay, a faithful port of
// cli/jarvis_cli/tui/setup_wizard.py's SetupWizardScreen. Same 4 steps
// (Welcome/Voice/Brain/Permissions), same settings.get/settings.set/
// voice.list_voices calls, and critically the SAME shared first-run flag:
// settings.get's `setup_complete` boolean. There is deliberately no
// TUI-only "have I onboarded" marker — finishing the wizard in either
// front-end persists setup_complete=true on the shared daemon, so the two
// can never desync (see setup_wizard.py's module docstring). If our own
// settings.get here discovers setup_complete is ALREADY true (e.g. the GUI
// finished onboarding in the gap between the caller's check and this
// mount), we skip straight to onDone rather than re-onboarding.
//
// Divergence from the Textual source (documented, not a bug): Python relies
// on Tab's default focus-traversal binding to move between fields/steps;
// this environment has no such built-in traversal (every OpenTUI focus move
// here is an explicit `.focus()` call — see Composer.tsx/Picker.tsx). Step
// navigation is Tab (Next/Finish) / Shift+Tab (Back) instead, plus Enter
// inside a text field does the same as Next (kept for python parity) and
// Back/Next/Finish are also clickable text.

import { TextAttributes } from "@opentui/core"
import type { InputRenderable, KeyEvent, SelectOption, SelectRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import { ArcReactor } from "../ui/ArcReactor"

export interface SetupWizardProps {
  onDone: () => void
}

const STEP_TITLES = ["Welcome", "Voice", "Brain", "Permissions"]
const STEP_COUNT = STEP_TITLES.length

const PERMISSION_OPTIONS: Array<[string, string]> = [
  ["high", "Cautious — ask before HIGH + MEDIUM"],
  ["medium", "Balanced — ask before HIGH only"],
  ["low", "Autonomous — only confirm the worst"],
]

interface VoiceOption {
  id: string
  label: string
}

export function SetupWizard(props: SetupWizardProps) {
  const app = useApp()

  const [skip, setSkip] = createSignal(false) // already setup_complete — render nothing
  const [step, setStep] = createSignal(0)
  const [assistantName, setAssistantName] = createSignal("Cindro")
  const [userName, setUserName] = createSignal("")
  const [ttsVoice, setTtsVoice] = createSignal("")
  const [voiceList, setVoiceList] = createSignal<VoiceOption[]>([])
  const [permissionLevel, setPermissionLevel] = createSignal<"high" | "medium" | "low">("medium")
  const [autoUpdate, setAutoUpdate] = createSignal(true)
  const [hasCli, setHasCli] = createSignal(true)
  const [mistralKeySet, setMistralKeySet] = createSignal(false)
  const [mistralKey, setMistralKey] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal("")

  let alive = true
  let nameRef: InputRenderable | undefined
  let usernameRef: InputRenderable | undefined
  let voiceSelectRef: SelectRenderable | undefined
  let permSelectRef: SelectRenderable | undefined

  onCleanup(() => {
    alive = false
  })

  // -- daemon round-trips (mirrors setup_wizard.py's _load) --------------------
  const load = async () => {
    const [settingsResult, voicesResult] = await Promise.allSettled([
      app.client.call("settings.get", {}, 15000),
      app.client.call("voice.list_voices", {}, 15000),
    ])
    if (!alive) return

    if (settingsResult.status === "fulfilled") {
      const res = settingsResult.value
      const settings = (res.settings ?? res) as Record<string, unknown>
      if (settings.setup_complete) {
        // Onboarded elsewhere (e.g. the GUI) between the caller's check and
        // this mount — never re-onboard; skip straight through.
        setSkip(true)
        props.onDone()
        return
      }
      const available = (settings.available_brains ?? {}) as Record<string, unknown>
      setHasCli(Boolean(available.codex) || Boolean(available.claude))
      const apiKeysSet = (settings.api_keys_set ?? {}) as Record<string, unknown>
      setMistralKeySet(Boolean(apiKeysSet.mistral))
      if (settings.assistant_name) setAssistantName(String(settings.assistant_name))
      if (settings.user_name) setUserName(String(settings.user_name))
      if ("tts_voice" in settings) setTtsVoice(String(settings.tts_voice ?? ""))
      const pl = settings.permission_level
      setPermissionLevel(pl === "high" || pl === "low" ? pl : "medium")
      const au = settings.auto_update
      setAutoUpdate(au === undefined || au === null ? true : Boolean(au))
      // The inputs are uncontrolled (InputRenderable.value is set-once at
      // construction) — actively re-sync them now that loaded values landed,
      // mirroring setup_wizard.py's _apply_loaded_values_to_inputs.
      if (nameRef) nameRef.value = assistantName()
      if (usernameRef) usernameRef.value = userName()
    }

    if (voicesResult.status === "fulfilled") {
      const voices = (voicesResult.value.voices ?? []) as Array<Record<string, unknown>>
      setVoiceList(
        voices.map((v) => ({ id: String(v.id ?? ""), label: String(v.label ?? v.id ?? "") })),
      )
    } else {
      setVoiceList([])
    }
  }

  onMount(() => {
    void load()
    queueMicrotask(() => nameRef?.focus())
  })

  // -- step navigation ------------------------------------------------------
  const goNext = () => {
    if (!alive || saving()) return
    if (step() < STEP_COUNT - 1) setStep((s) => s + 1)
    else void finish()
  }
  const goBack = () => {
    if (!alive || saving() || step() <= 0) return
    setStep((s) => s - 1)
  }

  const finish = async () => {
    setSaving(true)
    setSaveError("")
    const name = assistantName().trim()
    const patch: Record<string, unknown> = {
      setup_complete: true,
      assistant_name: name || "Cindro",
      user_name: userName().trim(),
      tts_voice: ttsVoice(),
      permission_level: permissionLevel(),
      auto_update: autoUpdate(),
    }
    // Mirrors setup_wizard.py's _finish(): only send a Mistral key when one
    // was typed and none is already set — never overwrite an existing key.
    if (!mistralKeySet() && mistralKey().trim()) {
      patch.api_keys = { mistral: mistralKey().trim() }
    }
    try {
      await app.client.call("settings.set", { patch }, 20000)
    } catch (e) {
      if (!alive) return
      setSaving(false)
      const msg = `setup failed: ${String(e)}`
      setSaveError(msg)
      app.notify(msg, "error")
      return
    }
    if (!alive) return
    props.onDone()
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!alive || skip()) return
      if (key.name === "tab") {
        if (key.shift) goBack()
        else goNext()
      }
    },
    {},
  )

  // Suppress the input's own default reaction to Tab (it should navigate
  // steps, never insert a literal tab character into a text field).
  const swallowTab = (key: KeyEvent) => {
    if (key.name === "tab") key.preventDefault()
  }

  const voiceOptions = (): SelectOption[] => {
    const list = voiceList()
    const opts = list.length ? list : [{ id: ttsVoice(), label: "Default voice" }]
    return opts.map((v) => ({ name: v.label, description: "", value: v.id }))
  }
  const voiceSelectedIndex = () => {
    const idx = voiceOptions().findIndex((o) => o.value === ttsVoice())
    return idx >= 0 ? idx : 0
  }
  const permSelectedIndex = () => PERMISSION_OPTIONS.findIndex(([k]) => k === permissionLevel())

  return (
    <Show when={!skip()}>
      <box
        position="absolute"
        left={0}
        right={0}
        top={0}
        bottom={0}
        zIndex={100}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        backgroundColor={theme.bgDeep}
      >
        <box
          flexDirection="column"
          border
          borderColor={theme.accent}
          backgroundColor={theme.surface}
          padding={2}
          width={70}
        >
          <box flexDirection="column" alignItems="center" marginBottom={1}>
            <ArcReactor size={9} thinking={false} />
          </box>
          <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
            FIRST-TIME SETUP
          </text>
          <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
            {STEP_TITLES[step()]}
          </text>

          <Show when={step() === 0}>
            <box flexDirection="column">
              <text fg={theme.textMuted}>
                Let's get you set up. This only takes a moment.
              </text>
              <text fg={theme.textMuted}>What should I call myself?</text>
              <input
                ref={(r: InputRenderable) => {
                  nameRef = r
                  r.value = assistantName()
                }}
                placeholder="Cindro"
                onInput={setAssistantName}
                onKeyDown={swallowTab}
                onSubmit={goNext}
              />
              <text fg={theme.textMuted}>And what should I call you? (optional)</text>
              <input
                ref={(r: InputRenderable) => {
                  usernameRef = r
                  r.value = userName()
                }}
                placeholder="Your name"
                onInput={setUserName}
                onKeyDown={swallowTab}
                onSubmit={goNext}
              />
            </box>
          </Show>

          <Show when={step() === 1}>
            <box flexDirection="column">
              <text fg={theme.textMuted}>Pick the voice I speak with.</text>
              <select
                ref={(r: SelectRenderable) => {
                  voiceSelectRef = r
                  queueMicrotask(() => r.focus())
                }}
                height={Math.min(8, Math.max(3, voiceOptions().length))}
                options={voiceOptions()}
                selectedIndex={voiceSelectedIndex()}
                onSelect={(_i: number, option: SelectOption | null) => {
                  if (option) setTtsVoice(String(option.value ?? option.name))
                }}
              />
            </box>
          </Show>

          <Show when={step() === 2}>
            <box flexDirection="column">
              <text fg={theme.textMuted}>
                {hasCli() ? "✓ Codex / Claude CLI detected" : "No Codex or Claude CLI found"}
              </text>
              <text fg={theme.textMuted}>
                {mistralKeySet()
                  ? "✓ Mistral API key already set"
                  : hasCli()
                    ? "Add a Mistral key for voice + vision (optional)"
                    : "Add a Mistral API key to get started"}
              </text>
              <Show when={!mistralKeySet()}>
                <box flexDirection="column">
                  <input
                    placeholder="Paste your Mistral API key…"
                    // No native password mask in InputRenderable — keep the
                    // real glyphs invisible and mirror typed length as dots.
                    textColor={theme.surface}
                    focusedTextColor={theme.surface}
                    backgroundColor={theme.surface}
                    focusedBackgroundColor={theme.surface}
                    onInput={setMistralKey}
                    onKeyDown={swallowTab}
                    onSubmit={goNext}
                  />
                  <text fg={theme.textFaint} selectable={false}>
                    {"•".repeat(mistralKey().length)}
                  </text>
                </box>
              </Show>
            </box>
          </Show>

          <Show when={step() === 3}>
            <box flexDirection="column">
              <text fg={theme.textMuted}>
                How cautious should Cindro be before risky actions?
              </text>
              <select
                ref={(r: SelectRenderable) => {
                  permSelectRef = r
                  queueMicrotask(() => r.focus())
                }}
                height={3}
                options={PERMISSION_OPTIONS.map(([value, label]) => ({
                  name: label,
                  description: "",
                  value,
                }))}
                selectedIndex={permSelectedIndex()}
                onSelect={(_i: number, option: SelectOption | null) => {
                  const v = option ? String(option.value ?? "") : ""
                  if (v === "high" || v === "medium" || v === "low") setPermissionLevel(v)
                }}
              />
              <box
                flexDirection="row"
                gap={1}
                marginTop={1}
                onMouseDown={() => setAutoUpdate((v) => !v)}
              >
                <text fg={theme.accent} selectable={false}>
                  {autoUpdate() ? "[x]" : "[ ]"}
                </text>
                <text fg={theme.textMuted} selectable={false}>
                  Keep Cindro up to date automatically
                </text>
              </box>
            </box>
          </Show>

          <Show when={saveError()}>
            <text fg={theme.danger} selectable={false}>
              ⚠ {saveError()}
            </text>
          </Show>

          <text fg={theme.textFaint} marginTop={1} selectable={false}>
            Step {step() + 1} / {STEP_COUNT}
          </text>
          <box flexDirection="row" gap={2} justifyContent="flex-end">
            <Show when={step() > 0}>
              <text fg={theme.textMuted} selectable={false} onMouseDown={goBack}>
                [ Back ]
              </text>
            </Show>
            <text
              fg={theme.accentBright}
              attributes={TextAttributes.BOLD}
              selectable={false}
              onMouseDown={goNext}
            >
              {saving() ? "[ Finishing… ]" : step() === STEP_COUNT - 1 ? "[ Finish ]" : "[ Next ]"}
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}
