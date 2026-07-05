// <ArcReactor/> — the brand centerpiece, everywhere the GUI uses
// ArcReactor.qml (topbar, spinners, empty states, voice orb…). Rendering is
// row-major <text> spans over the pure painter in arc-reactor.ts; identical
// geometry + the same two cyans as the desktop reactor.

import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js"

import { theme } from "../theme"
import type { ReactorRun } from "./arc-reactor"
import {
  advanceReactor,
  initialReactorState,
  paintReactor,
  rowRuns,
} from "./arc-reactor"

const TICK_MS = 100

export interface ArcReactorProps {
  size?: number
  spinning?: boolean
  thinking?: boolean
}

function runColor(run: ReactorRun) {
  if (run.color === "accentBright") return theme.accentBright
  if (run.color === "accent") return theme.accent
  return theme.textFaint
}

function runAttributes(run: ReactorRun): number | undefined {
  if (run.bold) return TextAttributes.BOLD
  if (run.dim) return TextAttributes.DIM
  return undefined
}

export function ArcReactor(props: ArcReactorProps) {
  const [state, setState] = createSignal(initialReactorState())

  onMount(() => {
    const timer = setInterval(() => {
      setState((s) =>
        advanceReactor(s, TICK_MS, {
          spinning: props.spinning ?? true,
          thinking: props.thinking ?? false,
        }),
      )
    }, TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  const grid = createMemo(() =>
    paintReactor(props.size ?? 13, state(), props.thinking ?? false),
  )

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={grid()}>
        {(row) => (
          <box flexDirection="row">
            <For each={rowRuns(row)}>
              {(run) => (
                <text fg={runColor(run)} attributes={runAttributes(run)} selectable={false}>
                  {run.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
