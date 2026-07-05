// COMPUTER page — "Jarvis drives your computer" (ComputerPage.qml parity on
// the terminal's honest surface: status + transcript + approvals; there is
// no lossless pixel path for the nested-desktop video).
//
//   a  start a co-worker on the AGENT desktop (session.create
//      {profile:"coworker", target:"agent", brain?, model?} — Bridge.cpp
//      startCoworker's exact params)
//   w  TAKE OVER MY SCREEN — gated behind an amber confirm (the GUI's
//      takeOverConfirm popup; the legacy TUI fired target:"real" bare on one
//      keypress, which we deliberately do NOT copy) → session.create
//      {target:"real"}, approval/biometric gated daemon-side
//   s  stop (session.cancel)
//   b/m brain + model pickers (settings.get brains/available_brains,
//      model.list — local selection like the GUI, not settings.set)
//   y/a/n answer a pending approval (allow/always/deny)
//
// The transcript is a dedicated SessionController + <Transcript> — the same
// event folding as Chat, disposed in onCleanup (the legacy pane leaked its
// pump; SessionController.dispose() kills pump + widget subscription).

import { TextAttributes } from "@opentui/core"
import type { KeyEvent, SelectOption, SelectRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { Picker } from "../chat/Picker"
import { SessionController } from "../chat/session"
import { Transcript } from "../chat/Transcript"
import { coworkSessionId, setCoworkSessionId } from "../engine"
import { theme } from "../theme"

interface PickerState {
  title: string
  options: Array<{ label: string; description?: string; value: string }>
  onPick: (value: string) => void
}

/**
 * The take-over confirm — ComputerPage.qml's amber takeOverConfirm Popup as
 * a terminal overlay. Follows src/chat/Picker.tsx exactly (focused <select>,
 * 150ms mount-grace so the 'w' that opened it can't instantly pick, Escape
 * cancels) but amber-framed with the GUI's warning copy.
 */
function TakeOverConfirm(props: { onYes: () => void; onCancel: () => void }) {
  let ref: SelectRenderable | undefined
  onMount(() => ref?.focus())
  const bornAt = Date.now()

  useKeyboard(
    (key: { name?: string }) => {
      if (key.name === "escape") props.onCancel()
    },
    {},
  )

  return (
    <box
      position="absolute"
      left={4}
      top={2}
      flexDirection="column"
      border
      borderColor={theme.amber}
      backgroundColor={theme.surface}
      minWidth={52}
      zIndex={50}
    >
      <text fg={theme.amber} attributes={TextAttributes.BOLD} selectable={false}>
        ⚠ TAKE OVER MY SCREEN
      </text>
      <text fg={theme.text} wrapMode="word">
        Jarvis will drive your ACTUAL desktop with a distinct cursor and a
        “JARVIS IS DRIVING” overlay. This requires biometric approval on a
        paired device. You can release control at any time.
      </text>
      <select
        ref={(r: SelectRenderable) => {
          ref = r
        }}
        height={4} /* the select draws 2 rows per option */
        options={[
          { name: "Yes — drive my real screen", description: "", value: "yes" },
          { name: "Cancel", description: "", value: "cancel" },
        ]}
        onSelect={(_i: number, option: SelectOption | null) => {
          if (Date.now() - bornAt < 150) return
          if (!option) return
          if (String(option.value) === "yes") props.onYes()
          else props.onCancel()
        }}
      />
      <text fg={theme.textFaint} selectable={false}>
        ↑↓ pick · Enter confirm · Esc cancel
      </text>
    </box>
  )
}

export function ComputerPage(props: { active: () => boolean }) {
  const app = useApp()
  const controller = new SessionController(app.client)

  const [target, setTarget] = createSignal<"agent" | "real" | null>(null)
  const [brain, setBrain] = createSignal("")
  const [model, setModel] = createSignal("")
  const [picker, setPicker] = createSignal<PickerState | null>(null)
  const [confirmTakeOver, setConfirmTakeOver] = createSignal(false)
  const [pulse, setPulse] = createSignal(true)

  const notice = (text: string, style?: "info" | "warn" | "error" | "success") =>
    controller.notice(text, style)

  // -- brain/model (GUI parity: LOCAL selection passed to session.create) ----
  const loadModels = async (forBrain: string): Promise<string[]> => {
    const params: Record<string, unknown> = {}
    if (forBrain) params.brain = forBrain // omitted → daemon default_brain
    const res = await app.client.call("model.list", params, 8000)
    return ((res.models ?? []) as unknown[]).map(String)
  }

  onMount(() => {
    void (async () => {
      try {
        const s = await app.client.call("settings.get", {}, 8000)
        const settings = (s.settings ?? s) as Record<string, unknown>
        setBrain(String(settings.default_brain ?? ""))
        const models = await loadModels(brain())
        if (models.length && !model()) setModel(models[0])
      } catch (e) {
        notice(`couldn't load brain/model defaults: ${String(e)}`, "warn")
      }
    })()
    const timer = setInterval(() => setPulse((p) => !p), 600)
    onCleanup(() => clearInterval(timer))
  })

  onCleanup(() => controller.dispose()) // the legacy pane leaked its pump

  const openBrainPicker = async () => {
    try {
      const s = await app.client.call("settings.get", {}, 8000)
      const settings = (s.settings ?? s) as Record<string, unknown>
      const brains = ((settings.brains ?? ["codex", "claude", "api"]) as unknown[]).map(String)
      const avail = (settings.available_brains ?? {}) as Record<string, unknown>
      setPicker({
        title: "CO-WORKER BRAIN",
        options: brains.map((b) => ({
          label: b,
          description: avail[b] === false ? "(unavailable on this machine)" : "",
          value: b,
        })),
        onPick: (v) => {
          setBrain(v)
          // GUI parity: picking a brain re-lists that brain's models.
          void loadModels(v)
            .then((models) => setModel(models[0] ?? ""))
            .catch((e) => notice(`model list failed: ${String(e)}`, "error"))
        },
      })
    } catch (e) {
      notice(`brain picker unavailable: ${String(e)}`, "error")
    }
  }

  const openModelPicker = async () => {
    try {
      const models = await loadModels(brain())
      setPicker({
        title: "CO-WORKER MODEL",
        options: models.map((m) => ({ label: m, value: m })),
        onPick: (v) => setModel(v),
      })
    } catch (e) {
      notice(`model picker unavailable: ${String(e)}`, "error")
    }
  }

  // -- session lifecycle ------------------------------------------------------
  const start = async (tgt: "agent" | "real") => {
    const params: Record<string, unknown> = { profile: "coworker", target: tgt }
    if (brain()) params.brain = brain() // omit → daemon default (Bridge parity)
    if (model()) params.model = model()
    const res = await app.client.call("session.create", params, 20000)
    const sid = String(res.session_id ?? "")
    if (!sid) throw new Error("session.create returned no session_id")
    setCoworkSessionId(sid)
    setTarget(tgt)
    // openSession bumps the pump generation, so a previous co-work session's
    // pump can never deliver into the new transcript (computer_pane.py's
    // _cancel_pump rule, structurally).
    await controller.openSession(sid, `co-work · ${tgt} desktop`)
    if (tgt === "real")
      notice("⚠ take-over requested — biometric approval gates the real screen", "warn")
    else notice("▶ co-worker started on the agent desktop", "success")
  }

  const stop = async () => {
    const sid = coworkSessionId()
    if (!sid) {
      notice("no active co-work session", "warn")
      return
    }
    await app.client.call("session.cancel", { session_id: sid })
    setCoworkSessionId("")
    setTarget(null)
    notice("■ co-work session stopped", "warn")
  }

  // -- keys (gated on active + no overlay; approvals win, Chat.tsx pattern) ---
  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || key.ctrl || picker() || confirmTakeOver()) return
      const approval = controller.pendingApproval()
      if (approval) {
        if (key.name === "y") void controller.respondApproval("allow")
        else if (key.name === "a") void controller.respondApproval("always")
        else if (key.name === "n") void controller.respondApproval("deny")
        return
      }
      // 1-9 answers a pending ask_user question (the transcript card says
      // "press 1-9 to pick" — so the keys must actually work; Chat parity).
      const question = controller.pendingQuestion()
      if (question && question.options.length) {
        const n = Number.parseInt(key.name ?? "", 10)
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, question.options.length)) {
          controller.answerQuestion(question.questionId, question.options[n - 1])
          return
        }
      }
      switch (key.name) {
        case "a":
          void start("agent").catch((e) => notice(String(e), "error"))
          break
        case "w":
          // NEVER bare — the GUI confirms first; the legacy TUI's unguarded
          // 'w' was a bug class, not a feature.
          setConfirmTakeOver(true)
          break
        case "s":
          void stop().catch((e) => notice(String(e), "error"))
          break
        case "b":
          void openBrainPicker()
          break
        case "m":
          void openModelPicker()
          break
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          // COMPUTER
        </text>
        <Show when={target() === "real"}>
          <text fg={theme.danger} attributes={TextAttributes.BOLD} selectable={false}>
            {pulse() ? "●" : "○"} DRIVING REAL SCREEN
          </text>
        </Show>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted} selectable={false}>
          BRAIN
        </text>
        <text fg={theme.accent} selectable={false}>
          {brain() || "default"}
        </text>
        <text fg={theme.textFaint} selectable={false}>
          (b)
        </text>
        <text fg={theme.textMuted} selectable={false}>
          · MODEL
        </text>
        <text fg={theme.accent} selectable={false}>
          {model() || "default"}
        </text>
        <text fg={theme.textFaint} selectable={false}>
          (m)
        </text>
      </box>
      <text fg={theme.textFaint} selectable={false}>
        a start co-worker (agent desktop) · w take over MY screen · s stop · y/a/n approvals
      </text>

      <Show
        when={coworkSessionId()}
        fallback={
          <text fg={theme.textFaint} selectable={false}>
            no active co-work session
          </text>
        }
      >
        <text fg={theme.accent} selectable={false}>
          ⚡ co-work session {coworkSessionId()} — {target() ?? "agent"} desktop
        </text>
      </Show>

      <Show when={controller.items.length === 0}>
        <text fg={theme.textFaint} wrapMode="word">
          No session yet. Press a and Jarvis drives a nested desktop with its own
          cursor — your screen stays yours.
        </text>
      </Show>
      {/* basis-0 wrapper is LOAD-BEARING: the Transcript scrollbox's
          intrinsic content height otherwise shrinks the fixed rows above as
          the transcript grows (opentui 0.3.4 flex quirk, verified). */}
      <box flexDirection="column" flexGrow={1} flexBasis={0}>
        <Transcript session={controller} />
      </box>

      <Show when={controller.status()}>
        <text fg={theme.textFaint} selectable={false}>
          {controller.status()}
        </text>
      </Show>
      <Show when={controller.pendingApproval()}>
        {(a) => (
          <box flexDirection="row" gap={1} border borderColor={theme.danger}>
            <text fg={theme.danger} attributes={TextAttributes.BOLD} selectable={false}>
              ✋ {a().summary}
            </text>
            <text fg={theme.textMuted} selectable={false}>
              y allow · a always · n deny
            </text>
          </box>
        )}
      </Show>

      <Show when={picker()}>
        {(p) => (
          <Picker
            title={p().title}
            options={p().options}
            onPick={(v) => {
              setPicker(null)
              p().onPick(v)
            }}
            onCancel={() => setPicker(null)}
          />
        )}
      </Show>

      <Show when={confirmTakeOver()}>
        <TakeOverConfirm
          onYes={() => {
            setConfirmTakeOver(false)
            void start("real").catch((e) => notice(String(e), "error"))
          }}
          onCancel={() => setConfirmTakeOver(false)}
        />
      </Show>
    </box>
  )
}
