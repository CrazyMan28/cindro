// ReplayPage — MISSION CONTROL // REPLAY, the terminal port of
// desktop/qml/ReplayPage.qml: scrub a past session like a video. Loads a
// session's full history (session.history → [{seq,ts,ev}]) and rebuilds the
// transcript to the cursor on every seek through a FRESH private
// SessionController (applyEvent(ev, true) — the same folding live chat
// uses), so tool cards, diffs and messages replay exactly as they rendered.
//
// ONE DELIBERATE UPGRADE over the GUI: the QML replay silently skips
// `widget`-kind events; here they route through the controller's
// injectWidget so canvases replay too.
//
// Transport (VCR parity): h/⏮ start · j step back · space play/pause ·
// k step fwd · l/⏭ end · s speed cycle 0.5×→1×→2×→4×; auto-advance every
// 600ms/speed and stop at the end. Read-only: no sending, no approvals.

import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"

import { useApp } from "../app-context"
import { Picker } from "../chat/Picker"
import { SessionController } from "../chat/session"
import { Transcript } from "../chat/Transcript"
import { theme } from "../theme"

const BASE_TICK_MS = 600 // auto-advance base; actual interval = base / speed
const SCRUB_WIDTH = 36

type Ev = Record<string, unknown>

interface PickerOption {
  label: string
  description?: string
  value: string
}

export function ReplayPage(props: { active: () => boolean }) {
  const app = useApp()
  const [sessionId, setSessionId] = createSignal("")
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [events, setEvents] = createSignal<Ev[]>([])
  const [cursor, setCursor] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [speed, setSpeed] = createSignal(1)
  const [error, setError] = createSignal("")
  const [pickerOpts, setPickerOpts] = createSignal<PickerOption[] | null>(null)
  const [controller, setController] = createSignal(new SessionController(app.client))

  const total = () => events().length

  // Rebuild the transcript to exactly `n` events: a FRESH controller folds
  // events 0..n with the replay flag (full rebuild per seek — cheap for the
  // ≤500-event histories sessions hold, and it keeps scrubbing dead simple).
  const seek = (n: number) => {
    const evs = events()
    const clamped = Math.max(0, Math.min(n, evs.length))
    const fresh = new SessionController(app.client)
    for (let i = 0; i < clamped; i++) {
      const ev = evs[i]
      if (String(ev.kind ?? "") === "widget") {
        // The GUI skips these; we render them. Tolerate spec/widget and
        // top-level/spec-level title aliases (widget.render broadcast shape).
        const spec = (ev.spec ?? ev.widget ?? {}) as Record<string, unknown>
        fresh.injectWidget(String(ev.title ?? spec.title ?? "widget"), spec)
      } else {
        fresh.applyEvent(ev, true)
      }
    }
    controller().dispose()
    setController(fresh)
    setCursor(clamped)
  }

  const stepBy = (d: number) => {
    setPlaying(false)
    seek(cursor() + d)
  }

  const togglePlay = () => {
    if (!total()) return
    if (!playing() && cursor() >= total()) seek(0) // replay from start (GUI parity)
    setPlaying((p) => !p)
  }

  const cycleSpeed = () => setSpeed((s) => (s >= 4 ? 0.5 : s < 1 ? 1 : s * 2))

  // ---- playback clock: interval retimes when speed changes ----------------
  createEffect(() => {
    if (!playing()) return
    const interval = Math.max(80, BASE_TICK_MS / speed())
    const timer = setInterval(() => {
      if (cursor() >= total()) {
        setPlaying(false) // transport stops at the end
        return
      }
      seek(cursor() + 1)
    }, interval)
    onCleanup(() => clearInterval(timer))
  })

  // ---- session picker ------------------------------------------------------
  const openPicker = async () => {
    setError("")
    try {
      const res = await app.client.call("session.list", {}, 15000)
      const sessions = (res.sessions ?? []) as Ev[]
      if (!sessions.length) {
        setError("no sessions to replay yet")
        return
      }
      setPickerOpts(
        sessions.map((s) => ({
          label: String(s.title ?? s.id ?? "untitled"),
          description: String(s.state ?? ""),
          value: String(s.id ?? ""),
        })),
      )
    } catch (e) {
      setError(`session.list failed: ${String(e)}`)
    }
  }

  const load = async (sid: string, title: string) => {
    setError("")
    setPlaying(false)
    try {
      const res = await app.client.call("session.history", { session_id: sid }, 20000)
      const evs = ((res.events ?? []) as Ev[]).map((e) => (e.ev ?? e) as Ev)
      const meta = (res.session ?? {}) as Ev
      setSessionId(sid)
      setSessionTitle(title || String(meta.title ?? sid))
      setEvents(evs)
      seek(evs.length) // start fully played-out; scrub back to rewind (GUI parity)
    } catch (e) {
      setError(`history unavailable: ${String(e)}`)
    }
  }

  // Open the picker on entry (first activation with nothing loaded); pause
  // playback whenever the page deactivates so a hidden tab never burns CPU.
  let wasActive = false
  createEffect(() => {
    const a = props.active()
    if (!a) setPlaying(false)
    else if (!wasActive && !sessionId() && !pickerOpts()) void openPicker()
    wasActive = a
  })

  // ---- transport keys (gated on the page being the active one) ------------
  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || pickerOpts() || key.ctrl || key.meta || key.option) return
      switch (key.name) {
        case "h": // ⏮ jump to start
          setPlaying(false)
          seek(0)
          break
        case "j": // step back
          stepBy(-1)
          break
        case "space": // play / pause
          togglePlay()
          break
        case "k": // step forward
          stepBy(1)
          break
        case "l": // ⏭ jump to end
          setPlaying(false)
          seek(total())
          break
        case "s": // speed cycle
          cycleSpeed()
          break
        case "p": // re-open the session picker
          void openPicker()
          break
        default:
          break
      }
    },
    {},
  )

  onCleanup(() => controller().dispose())

  // "cursor/total · event label" readout (evLabel parity with the QML page).
  const evLabel = (i: number): string => {
    const ev = events()[i]
    if (!ev) return ""
    const k = String(ev.kind ?? "?")
    if (k === "tool_call" || k === "tool_result") return String(ev.name ?? "tool")
    if (k === "message") return `${String(ev.role ?? "msg")} message`
    return k
  }
  const readout = () =>
    `${cursor()} / ${total()}` + (cursor() > 0 ? `  ·  ${evLabel(cursor() - 1)}` : "")

  const scrubBar = () => {
    const filled = Math.round((cursor() / Math.max(1, total())) * SCRUB_WIDTH)
    return "━".repeat(filled) + "─".repeat(SCRUB_WIDTH - filled)
  }

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          // REPLAY
        </text>
        <text fg={theme.textFaint} selectable={false}>
          {sessionId()
            ? `${sessionTitle()}  ·  ${total()} events`
            : "p pick a session to replay"}
        </text>
      </box>

      <Show when={error()}>
        <text fg={theme.danger} attributes={TextAttributes.BOLD} wrapMode="word">
          ✖ {error()}
        </text>
      </Show>

      <Show
        when={controller().items.length > 0}
        fallback={
          <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD} selectable={false}>
              {sessionId() ? "REWOUND TO START" : "NO SESSION LOADED"}
            </text>
            <text fg={theme.textFaint} selectable={false}>
              {sessionId() ? "space play · k step forward" : "p opens the session picker"}
            </text>
          </box>
        }
      >
        <Transcript session={controller()} />
      </Show>

      {/* ---- transport bar: ⏮ ◀ ▶/⏸ ▶ ⏭ · scrubber · speed ---------------- */}
      <box
        flexDirection="column"
        flexShrink={0}
        border={["top"]}
        borderColor={theme.hairlineSoft}
      >
        <box flexDirection="row" gap={2}>
          <text fg={playing() ? theme.accentBright : theme.textMuted} selectable={false}>
            ⏮h · j◀ · space {playing() ? "⏸" : "▶"} · ▶k · l⏭
          </text>
          <text fg={theme.accent} selectable={false}>
            {scrubBar()}
          </text>
          <text fg={theme.amber} selectable={false}>
            {speed()}× s
          </text>
        </box>
        <text fg={theme.textMuted} selectable={false}>
          {readout()}
        </text>
      </box>

      <Show when={pickerOpts()}>
        {(opts) => (
          <Picker
            title="REPLAY · PICK SESSION"
            options={opts()}
            onPick={(sid) => {
              const picked = opts().find((o) => o.value === sid)
              setPickerOpts(null)
              void load(sid, picked?.label ?? "")
            }}
            onCancel={() => setPickerOpts(null)}
          />
        )}
      </Show>
    </box>
  )
}
