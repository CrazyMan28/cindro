// App-wide incoming/active call banner — the terminal PhoneCallOverlay.qml.
// Self-contained: polls list_active_calls every 3s ALWAYS (cheap; skipped
// while the daemon is disconnected, phone_pane.py:286) and subscribes to
// the daemon's phone.event pushes for instant refresh (call_message →
// transcript only; any other lifecycle event → full re-poll). Ringing calls
// win over active ones (PhoneCallOverlay._doPoll). Keys are live ONLY while
// a call exists: A accept / R reject while ringing, E end while active —
// the exact routes/bodies the QML sends:
//   POST /api/calls/:id/accept {extension:"100"}
//   POST /api/calls/:id/reject {extension:"100", reason:"rejected_by_user"}
//   end_call {call_id, extension:"100", reason:"user_ended"}

import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import type { TranscriptLine } from "./api"
import {
  ACTIVE_STATES,
  asList,
  fmtElapsed,
  httpFailure,
  mergeTranscript,
  phoneHttp,
  phoneMcp,
  pickBannerCall,
  RINGING_STATES,
  str,
} from "./api"

const POLL_MS = 3000

interface BannerCall {
  id: string
  state: string
  from: string
  to: string
  reason: string
  urgency: string
}

export function CallOverlay() {
  const app = useApp()
  const [call, setCall] = createSignal<BannerCall | null>(null)
  const [elapsed, setElapsed] = createSignal(0)
  const [tx, setTx] = createSignal<TranscriptLine[]>([])
  const [err, setErr] = createSignal("")
  let currentId = ""

  const refreshTranscript = async (id: string) => {
    const res = await phoneMcp(app.client, "get_call_transcript", { call_id: id })
    if (res.error) {
      setErr(`transcript: ${res.error.message}`)
      return
    }
    setTx(mergeTranscript(res.data))
  }

  const clear = () => {
    currentId = ""
    setCall(null)
    setElapsed(0)
    setTx([])
  }

  const doPoll = async () => {
    if (!app.client.connected) return
    const res = await phoneMcp(app.client, "list_active_calls")
    if (res.error) {
      setErr(`list_active_calls: ${res.error.message}`)
      return
    }
    setErr("")
    const found = pickBannerCall(asList(res.data))
    if (!found) {
      clear()
      return
    }
    const id = str(found.id)
    if (id !== currentId) {
      currentId = id
      setElapsed(0)
      setTx([])
    }
    const state = str(found.state)
    setCall({
      id,
      state,
      from: str(found.from_extension, "—"),
      to: str(found.to_extension, "—"),
      reason: str(found.reason),
      urgency: str(found.urgency, "normal"),
    })
    if (ACTIVE_STATES.includes(state)) void refreshTranscript(id)
  }

  onMount(() => {
    app.client.start() // idempotent — the overlay may be the first mount
    void doPoll()
    // Fast starter — the mount poll usually races the websocket connect.
    let started = false
    const quick = setInterval(() => {
      if (started) clearInterval(quick)
      else if (app.client.connected) {
        started = true
        void doPoll()
      }
    }, 250)
    const poll = setInterval(() => void doPoll(), POLL_MS)
    const tick = setInterval(() => {
      if (call()) setElapsed((s) => s + 1)
    }, 1000)
    const off = app.client.on("phone.event", (_event, data) => {
      if (str(data.type) === "call_message") {
        if (currentId) void refreshTranscript(currentId)
      } else void doPoll()
    })
    onCleanup(() => {
      clearInterval(quick)
      clearInterval(poll)
      clearInterval(tick)
      off()
    })
  })

  const accept = async () => {
    const c = call()
    if (!c) return
    const res = await phoneHttp(app.client, "POST", `/api/calls/${c.id}/accept`, {
      extension: "100",
    })
    const fail = httpFailure(res)
    if (fail) setErr(`accept: ${fail}`)
    void doPoll()
  }

  const reject = async () => {
    const c = call()
    if (!c) return
    const res = await phoneHttp(app.client, "POST", `/api/calls/${c.id}/reject`, {
      extension: "100",
      reason: "rejected_by_user",
    })
    const fail = httpFailure(res)
    if (fail) setErr(`reject: ${fail}`)
    else clear()
    void doPoll()
  }

  const end = async () => {
    const c = call()
    if (!c) return
    const res = await phoneMcp(app.client, "end_call", {
      call_id: c.id,
      extension: "100",
      reason: "user_ended",
    })
    if (res.error) setErr(`end_call: ${res.error.message}`)
    else clear()
    void doPoll()
  }

  const ringing = () => RINGING_STATES.includes(call()?.state ?? "")
  const isActive = () => ACTIVE_STATES.includes(call()?.state ?? "")

  useKeyboard(
    (key: KeyEvent) => {
      const c = call()
      if (!c) return // A/R/E only while a call is ringing/active
      if (ringing() && key.name === "a") {
        key.preventDefault()
        void accept()
      } else if (ringing() && key.name === "r") {
        key.preventDefault()
        void reject()
      } else if (isActive() && key.name === "e") {
        key.preventDefault()
        void end()
      }
    },
    {},
  )

  return (
    <Show when={call()}>
      {(c) => (
        <box
          flexDirection="column"
          flexShrink={0}
          border
          borderColor={ringing() ? theme.amber : theme.accent}
          backgroundColor={theme.surface}
          paddingLeft={1}
          paddingRight={1}
        >
          <box flexDirection="row" gap={2}>
            <text
              fg={ringing() ? theme.amber : theme.accentBright}
              attributes={TextAttributes.BOLD}
              selectable={false}
            >
              ✆ {ringing() ? "INCOMING CALL" : "ACTIVE CALL"}
            </text>
            <text fg={theme.textMuted} selectable={false}>
              ext {c().from} → {c().to}
            </text>
            <Show when={c().urgency !== "normal" && c().urgency.length > 0}>
              <text
                fg={
                  c().urgency === "high" || c().urgency === "critical"
                    ? theme.danger
                    : theme.amber
                }
                attributes={TextAttributes.BOLD}
                selectable={false}
              >
                [{c().urgency.toUpperCase()}]
              </text>
            </Show>
            <box flexGrow={1} />
            <text
              fg={ringing() ? theme.amber : theme.accent}
              attributes={TextAttributes.BOLD}
              selectable={false}
            >
              {fmtElapsed(elapsed())}
            </text>
          </box>
          <Show when={c().reason}>
            <text fg={theme.text} wrapMode="word">
              {c().reason}
            </text>
          </Show>
          <Show when={isActive()}>
            <For
              each={tx().slice(-3)}
              fallback={<text fg={theme.textFaint}>Awaiting transcript…</text>}
            >
              {(line) => (
                <text fg={line.isAgent ? theme.accentBright : theme.text} wrapMode="word">
                  [{line.speaker}] {line.body}
                </text>
              )}
            </For>
          </Show>
          <text fg={theme.textFaint} selectable={false}>
            {ringing() ? "A accept · R reject" : "E end call"}
          </text>
          <Show when={err()}>
            <text fg={theme.danger} wrapMode="word">
              {err()}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}
