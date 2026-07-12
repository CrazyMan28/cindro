// <LockGate/> — the TUI's 2FA + fingerprint cross-device unlock overlay,
// a faithful port of cli/jarvis_cli/tui/lock_gate.py's LockGateScreen (see
// that file's module docstring for the full contract). The orchestrator
// mounts this BEFORE the main app is usable and swallows all input under it
// until `onDone` fires:
//
//   1. On mount, call auth.request({origin:"desktop"}) ONCE.
//   2. FAIL-OPEN: any error, "no phone paired", or an already-approved
//      challenge dismisses immediately — a user with no paired device must
//      never be locked out of their own terminal, and this must never block
//      forever on a challenge nobody will ever answer.
//   3. Otherwise poll auth.status every 1.5s up to a 130s hard timeout.
//   4. A PIN fallback (settings.get's has_desktop_pin) submits to
//      auth.verify_pin; any non-"approved" reply is treated as a wrong PIN.
//   5. 'r' retries (re-mints a challenge) once the phase is retryable.
//
// `dismissed`/`alive` guard the double-dismiss race (phone-poll AND a
// concurrent PIN submit both resolving "approved") and stray async
// continuations firing after unmount.

import { TextAttributes } from "@opentui/core"
import type { InputRenderable, KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import { ArcReactor } from "../ui/ArcReactor"

export interface LockGateProps {
  onDone: () => void
}

type Phase = "starting" | "waiting" | "denied" | "expired" | "timeout"

// Message text per phase — lifted straight from LockGate.qml / lock_gate.py.
const PHASE_MESSAGES: Record<Phase, string> = {
  starting: "Requesting unlock…",
  waiting:
    "Approve on your phone — tap the notification and confirm with your fingerprint.",
  denied: "Sign-in was denied on your phone.",
  expired: "The unlock request expired.",
  timeout: "Timed out waiting for approval.",
}
const RETRYABLE = new Set<Phase>(["denied", "expired", "timeout"])
const POLL_MS = 1500
const TIMEOUT_MS = 130_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function LockGate(props: LockGateProps) {
  const app = useApp()
  const [phase, setPhase] = createSignal<Phase>("starting")
  const [hasPin, setHasPin] = createSignal(false)
  const [pinError, setPinError] = createSignal(false)
  const [pinDraft, setPinDraft] = createSignal("")

  let challengeId = ""
  let dismissed = false
  let alive = true
  let runToken = 0
  let pinRef: InputRenderable | undefined

  // -- the ONE path to a successful unlock (phone poll OR PIN) ----------------
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    props.onDone()
  }

  const run = async (token: number): Promise<void> => {
    setPhase("starting")
    let result: Record<string, unknown>
    try {
      result = await app.client.call("auth.request", { origin: "desktop" }, 15000)
    } catch {
      dismiss() // fail-open: never lock the user out of their own terminal.
      return
    }
    if (!alive || token !== runToken) return
    if (!result.paired || result.state === "approved") {
      dismiss() // fail-open (no paired phone) / already approved.
      return
    }
    challengeId = String(result.challenge_id ?? "")
    setPhase("waiting")

    const deadline = Date.now() + TIMEOUT_MS
    while (phase() === "waiting") {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        if (alive && token === runToken) setPhase("timeout")
        return
      }
      await sleep(Math.min(POLL_MS, remaining))
      if (!alive || token !== runToken || phase() !== "waiting") return
      let status: Record<string, unknown>
      try {
        status = await app.client.call(
          "auth.status",
          { challenge_id: challengeId },
          10000,
        )
      } catch {
        continue // transient — keep polling until the hard timeout.
      }
      if (!alive || token !== runToken) return
      const state = status.state
      if (state === "approved") {
        dismiss()
        return
      }
      if (state === "denied" || state === "expired") {
        setPhase(state)
        return
      }
    }
  }

  const start = () => {
    runToken++
    void run(runToken)
  }

  const loadPinSetting = async () => {
    try {
      const res = await app.client.call("settings.get", {}, 10000)
      if (!alive) return
      const settings = (res.settings ?? res) as Record<string, unknown>
      setHasPin(Boolean(settings.has_desktop_pin))
    } catch {
      // PIN fallback just stays hidden — the phone-poll path still works.
    }
  }

  onMount(() => {
    void loadPinSetting()
    start()
  })
  onCleanup(() => {
    alive = false
    runToken++ // orphan any in-flight run()/poll loop
  })

  const retry = () => {
    if (!alive || !RETRYABLE.has(phase())) return
    setPinError(false)
    setPinDraft("")
    challengeId = ""
    start()
  }

  const verifyPin = async (pin: string) => {
    let result: Record<string, unknown>
    try {
      result = await app.client.call(
        "auth.verify_pin",
        { challenge_id: challengeId, pin },
        15000,
      )
    } catch {
      result = {}
    }
    if (!alive) return
    if (result.state === "approved") {
      dismiss()
      return
    }
    // Any non-approved reply (or a raised error) is a wrong PIN — matches
    // Bridge.cpp's unconditional pinRejected() on !ok.
    setPinError(true)
    setPinDraft("")
    if (pinRef) pinRef.value = ""
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!alive) return
      if (key.name === "r") retry()
    },
    {},
  )

  const reactorThinking = () => phase() === "starting" || phase() === "waiting"

  return (
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
        alignItems="center"
        border
        borderColor={theme.accent}
        backgroundColor={theme.surface}
        padding={2}
        width={56}
      >
        <ArcReactor size={13} thinking={reactorThinking()} />
        <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
          CINDRO LOCKED
        </text>
        <text fg={theme.textMuted} selectable={false} wrapMode="word">
          {PHASE_MESSAGES[phase()]}
        </text>
        <Show when={hasPin() && phase() !== "starting"}>
          <box flexDirection="column" alignItems="center" marginTop={1}>
            <text fg={pinError() ? theme.danger : theme.textFaint} selectable={false}>
              {pinError() ? "WRONG PIN — TRY AGAIN" : "OR UNLOCK WITH YOUR PIN"}
            </text>
            <input
              ref={(r: InputRenderable) => {
                pinRef = r
                queueMicrotask(() => r.focus())
              }}
              placeholder="PIN"
              // No native password mask in InputRenderable — keep the real
              // glyphs invisible (fg == bg, focused or not) and mirror the
              // typed length as dots below instead.
              textColor={theme.surface}
              focusedTextColor={theme.surface}
              backgroundColor={theme.surface}
              focusedBackgroundColor={theme.surface}
              onInput={(v: string) => setPinDraft(v)}
              onSubmit={(v: unknown) => {
                const pin = (typeof v === "string" && v ? v : pinDraft()).trim()
                if (pin) void verifyPin(pin)
              }}
            />
            <text fg={theme.textFaint} selectable={false}>
              {"•".repeat(pinDraft().length)}
            </text>
          </box>
        </Show>
        <Show when={RETRYABLE.has(phase())}>
          <text
            fg={theme.accentBright}
            attributes={TextAttributes.BOLD}
            selectable={false}
            onMouseDown={retry}
          >
            [ RETRY — r ]
          </text>
        </Show>
      </box>
    </box>
  )
}
