// <Widget/> — the terminal renderer for the Jarvis widget DSL (the SAME
// JSON spec the Android WidgetBitmapRenderer and desktop WidgetRenderer.qml
// interpret; safe recursive interpreter, nothing is ever eval'd).
//
// Node types (full GUI set): column, row, grid, text, badge, rect, divider,
// progress, spacer, list, canvas, pager, button, link, image, svg.
// vs the legacy canvas_render.py this ADDS: interactive button/link (action
// allow-list {send}|{skill,args} — identical to CanvasPage.handleAction),
// pager next/prev navigation, the anim layer (pulse/blink/spin/fade/float
// approximated with cell-safe effects), and image/svg placeholders that the
// Phase-4b terminal-graphics pass upgrades where the terminal supports it.
// Canvas ops stay a compact description list — terminal cells aren't pixels
// (same documented translation as the legacy renderer).

import { RGBA, TextAttributes } from "@opentui/core"
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"

import { theme } from "../theme"
import { tokens } from "../theme/tokens"
import { rasterizeCanvas } from "./braille"

export interface WidgetAction {
  send?: string
  skill?: string
  args?: string
}

export interface WidgetProps {
  spec: Record<string, unknown>
  onAction?: (action: WidgetAction) => void
}

type Spec = Record<string, unknown>

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"]

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

function colorOf(v: unknown, fallback = theme.accent): RGBA {
  const s = str(v)
  if (!s || !s.startsWith("#")) return fallback // named colors fall back
  try {
    return RGBA.fromHex(s)
  } catch {
    return fallback
  }
}

/**
 * The anim layer, cell-safe: pulse/blink toggle emphasis on the node's
 * period; spin drives a spinner glyph; fade/float read as a slow pulse.
 * Returns a phase signal (0/1) and the spinner frame index.
 */
function useAnim(anim: Spec | undefined) {
  const [phase, setPhase] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  onMount(() => {
    if (!anim) return
    const duration = Math.max(150, num(anim.duration, 1200))
    const timer = setInterval(
      () => {
        setPhase((p) => (p + 1) % 2)
        setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
      },
      str(anim.type) === "spin" ? Math.max(100, duration / 4) : duration / 2,
    )
    onCleanup(() => clearInterval(timer))
  })
  return { phase, frame, type: str(anim?.type) }
}

/** ONLY {send} or {skill,args} pass — the same allow-list every Jarvis
 * frontend enforces (CanvasPage.handleAction / StandaloneWidget). */
export function sanitizeAction(raw: unknown): WidgetAction | null {
  if (typeof raw !== "object" || raw === null) return null
  const a = raw as Spec
  if (typeof a.send === "string" && a.send) return { send: a.send }
  if (typeof a.skill === "string" && a.skill)
    return { skill: a.skill, args: typeof a.args === "string" ? a.args : "" }
  return null
}

function Frame(props: { spec: Spec; children: any }) {
  const bordered = () => Boolean(props.spec.border) || Boolean(props.spec.bg)
  const pad = () => Math.max(0, num(props.spec.pad, 0))
  return (
    <Show when={bordered() || pad() > 0} fallback={props.children}>
      <box
        flexDirection="column"
        border={bordered() ? true : undefined}
        borderColor={props.spec.border ? colorOf(props.spec.border, theme.hairline) : theme.hairline}
        backgroundColor={props.spec.bg ? colorOf(props.spec.bg, theme.surface) : undefined}
        padding={pad()}
      >
        {props.children}
      </box>
    </Show>
  )
}

export function Widget(props: WidgetProps): any {
  const spec = () => props.spec ?? {}
  const type = () => str(spec().type)
  const anim = useAnim(spec().anim as Spec | undefined)
  const dimNow = () =>
    Boolean(spec().anim) && anim.type !== "spin" && anim.phase() === 1

  const children = () => ((spec().children ?? []) as Spec[]).filter(Boolean)

  return (
    <Switch
      fallback={
        <text fg={theme.textFaint}>[unsupported widget node: {type() || "?"}]</text>
      }
    >
      <Match when={type() === "column"}>
        <Frame spec={spec()}>
          <box flexDirection="column">
            <For each={children()}>
              {(c) => <Widget spec={c} onAction={props.onAction} />}
            </For>
          </box>
        </Frame>
      </Match>
      <Match when={type() === "row"}>
        <Frame spec={spec()}>
          <box flexDirection="row" gap={Math.max(0, num(spec().gap, 1))}>
            <For each={children()}>
              {(c) => <Widget spec={c} onAction={props.onAction} />}
            </For>
          </box>
        </Frame>
      </Match>
      <Match when={type() === "grid"}>
        <Frame spec={spec()}>
          {(() => {
            const cols = Math.max(1, num(spec().cols, 1))
            const rows: Spec[][] = []
            const kids = children()
            for (let i = 0; i < kids.length; i += cols) rows.push(kids.slice(i, i + cols))
            return (
              <box flexDirection="column">
                <For each={rows}>
                  {(row) => (
                    <box flexDirection="row" gap={Math.max(0, num(spec().gap, 1))}>
                      <For each={row}>
                        {(c) => <Widget spec={c} onAction={props.onAction} />}
                      </For>
                    </box>
                  )}
                </For>
              </box>
            )
          })()}
        </Frame>
      </Match>
      <Match when={type() === "text"}>
        <text
          fg={colorOf(spec().color, theme.text)}
          attributes={
            (spec().bold ? TextAttributes.BOLD : 0) | (dimNow() ? TextAttributes.DIM : 0) ||
            undefined
          }
          wrapMode="word"
        >
          {str(spec().text)}
        </text>
      </Match>
      <Match when={type() === "badge"}>
        <box border borderColor={theme.accent} flexShrink={0}>
          <text
            fg={theme.accent}
            attributes={TextAttributes.BOLD | (dimNow() ? TextAttributes.DIM : 0)}
            selectable={false}
          >
            {" "}
            {str(spec().text)}{" "}
          </text>
        </box>
      </Match>
      <Match when={type() === "rect"}>
        <box height={Math.max(1, num(spec().h, 1))} backgroundColor={colorOf(spec().color)} />
      </Match>
      <Match when={type() === "divider"}>
        <text fg={colorOf(spec().color, theme.hairline)} selectable={false}>
          {"─".repeat(40)}
        </text>
      </Match>
      <Match when={type() === "progress"}>
        {(() => {
          const rawValue = num(spec().value, 0)
          const ratio = Math.max(0, Math.min(1, rawValue > 1 ? rawValue / 100 : rawValue))
          const width = 30
          const filled = Math.round(ratio * width)
          return (
            <box flexDirection="row">
              <text fg={theme.accent} selectable={false}>
                {"█".repeat(filled)}
              </text>
              <text fg={theme.hairline} selectable={false}>
                {"░".repeat(width - filled)}
              </text>
              <text fg={theme.textMuted} selectable={false}>
                {" "}
                {Math.round(ratio * 100)}%
              </text>
            </box>
          )
        })()}
      </Match>
      <Match when={type() === "spacer"}>
        <text selectable={false}>{" ".repeat(Math.max(1, num(spec().size, 8)))}</text>
      </Match>
      <Match when={type() === "list"}>
        <Frame spec={spec()}>
          <box flexDirection="column">
            <For each={(spec().rows ?? []) as Spec[]}>
              {(row) => (
                <box flexDirection="row" gap={1}>
                  <text fg={colorOf(row.color, theme.text)} wrapMode="word">
                    {str(row.text)}
                  </text>
                  <Show when={row.sub}>
                    <text fg={theme.textFaint}>{str(row.sub)}</text>
                  </Show>
                  <Show when={row.badge}>
                    <text fg={theme.accent} selectable={false}>
                      {str(row.badge)}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </Frame>
      </Match>
      <Match when={type() === "canvas"}>
        <Frame spec={spec()}>
          {/* Actually DRAW the vector ops with braille dots (the GUI
              rasterizes; we do too) instead of listing coordinates. */}
          <Show
            when={((spec().ops ?? []) as Spec[]).length > 0}
            fallback={<text fg={theme.textFaint}>(empty canvas)</text>}
          >
            <box flexDirection="column">
              <For each={rasterizeCanvas(spec(), { defaultColor: tokens.accent })}>
                {(row) => (
                  <box flexDirection="row">
                    <For each={row.runs}>
                      {(run) => (
                        <text
                          fg={run.color ? colorOf(run.color) : theme.accent}
                          selectable={false}
                        >
                          {run.text}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </Frame>
      </Match>
      <Match when={type() === "pager"}>
        {(() => {
          const pages = () => ((spec().pages ?? []) as Spec[]).filter(Boolean)
          const [page, setPage] = createSignal(
            Math.min(Math.max(0, num(spec().page, 0)), Math.max(0, pages().length - 1)),
          )
          return (
            <box flexDirection="column">
              <Show when={pages()[page()]}>
                <Widget spec={pages()[page()]} onAction={props.onAction} />
              </Show>
              <Show when={pages().length > 1}>
                <box flexDirection="row" gap={1}>
                  <text
                    fg={theme.accent}
                    selectable={false}
                    onMouseDown={() =>
                      setPage((p) => (p - 1 + pages().length) % pages().length)
                    }
                  >
                    [‹]
                  </text>
                  <text fg={theme.textMuted} selectable={false}>
                    {pages()
                      .map((_, i) => (i === page() ? "●" : "○"))
                      .join(" ")}
                  </text>
                  <text
                    fg={theme.accent}
                    selectable={false}
                    onMouseDown={() => setPage((p) => (p + 1) % pages().length)}
                  >
                    [›]
                  </text>
                </box>
              </Show>
            </box>
          )
        })()}
      </Match>
      <Match when={type() === "button"}>
        {(() => {
          const action = sanitizeAction(spec().action)
          return (
            <box
              border
              borderColor={action ? theme.accent : theme.hairline}
              flexShrink={0}
              onMouseDown={() => {
                if (action) props.onAction?.(action)
              }}
            >
              <text
                fg={action ? theme.accentBright : theme.textFaint}
                attributes={TextAttributes.BOLD | (dimNow() ? TextAttributes.DIM : 0)}
                selectable={false}
              >
                {" "}
                {anim.type === "spin" ? `${SPINNER_FRAMES[anim.frame()]} ` : ""}
                {str(spec().text, "button")}{" "}
              </text>
            </box>
          )
        })()}
      </Match>
      <Match when={type() === "link"}>
        {(() => {
          const href = str(spec().href ?? spec().url)
          const safe = href.startsWith("http://") || href.startsWith("https://")
          return (
            <text
              fg={safe ? theme.accent2 : theme.textFaint}
              attributes={TextAttributes.UNDERLINE}
              onMouseDown={() => {
                // scheme-guarded, same as WidgetRenderer.qml's link node
                if (safe) props.onAction?.({ send: `open ${href}` })
              }}
            >
              {str(spec().text, href)}
            </text>
          )
        })()}
      </Match>
      <Match when={type() === "image"}>
        <box border borderColor={theme.hairlineSoft} flexShrink={0}>
          <text fg={theme.textFaint} selectable={false}>
            ▦ image · {str(spec().src ?? spec().url, "(no src)").slice(0, 60)}
          </text>
        </box>
      </Match>
      <Match when={type() === "svg"}>
        <box border borderColor={theme.hairlineSoft} flexShrink={0}>
          <text fg={theme.textFaint} selectable={false}>
            ◇ vector graphic ({str(spec().svg).length} bytes svg)
          </text>
        </box>
      </Match>
    </Switch>
  )
}
