// <CustomPage/> — Jarvis-authored custom pages (tui_add_page /
// tui_edit_page), the load-bearing mechanism that MUST survive every
// rewrite. Declarative kinds only, no code (custom_pane.py parity):
//   log{path}       — tail the last 200 lines, refreshed every 3s
//   table{columns?,rows} — static table
//   markdown{text}  — rendered markdown
//   widget{spec}    — the full widget DSL (upgraded vs legacy: interactive)
//   list{items}     — bullet list

import { TextAttributes } from "@opentui/core"
import { createSignal, For, Match, onCleanup, onMount, Switch } from "solid-js"

import { readFileSync } from "node:fs"

import { syntaxStyle, theme } from "../../theme"
import { Widget } from "../../widgets/Widget"
import type { ManifestPage } from "./types"

const LOG_TAIL_LINES = 200
const LOG_REFRESH_MS = 3000

function LogView(props: { path: string }) {
  const [text, setText] = createSignal("(loading…)")
  const refresh = () => {
    if (!props.path) {
      setText("(no path configured)")
      return
    }
    try {
      const lines = readFileSync(props.path, "utf8").split("\n")
      setText(lines.slice(-LOG_TAIL_LINES).join("\n") || "(empty)")
    } catch (e) {
      setText(`(couldn't read ${props.path}: ${String(e)})`)
    }
  }
  onMount(() => {
    refresh()
    const timer = setInterval(refresh, LOG_REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
      <text fg={theme.textMuted}>{text()}</text>
    </scrollbox>
  )
}

export function CustomPage(props: { page: ManifestPage; onSendChat?: (text: string) => void }) {
  const config = () => props.page.config ?? {}
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
        // {props.page.title.toUpperCase()} ✦
      </text>
      <Switch
        fallback={
          <text fg={theme.textFaint}>[unsupported custom page kind: {props.page.kind}]</text>
        }
      >
        <Match when={props.page.kind === "log"}>
          <LogView path={String(config().path ?? "")} />
        </Match>
        <Match when={props.page.kind === "markdown"}>
          <scrollbox flexGrow={1}>
            <markdown content={String(config().text ?? "")} syntaxStyle={syntaxStyle()} />
          </scrollbox>
        </Match>
        <Match when={props.page.kind === "widget"}>
          <scrollbox flexGrow={1}>
            <Widget
              spec={(config().spec ?? {}) as Record<string, unknown>}
              onAction={(a) => {
                if (a.send) props.onSendChat?.(a.send)
                else if (a.skill) props.onSendChat?.(`/${a.skill} ${a.args ?? ""}`.trim())
              }}
            />
          </scrollbox>
        </Match>
        <Match when={props.page.kind === "list"}>
          <scrollbox flexGrow={1}>
            <For each={((config().items ?? []) as unknown[]).map(String)}>
              {(item) => (
                <text fg={theme.text} wrapMode="word">
                  • {item}
                </text>
              )}
            </For>
          </scrollbox>
        </Match>
        <Match when={props.page.kind === "table"}>
          {(() => {
            const rows = (config().rows ?? []) as Array<Record<string, unknown>>
            const cols =
              ((config().columns ?? []) as string[]).length > 0
                ? ((config().columns ?? []) as string[])
                : rows.length
                  ? Object.keys(rows[0])
                  : []
            return (
              <scrollbox flexGrow={1}>
                <box flexDirection="row" gap={2}>
                  <For each={cols}>
                    {(c) => (
                      <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                        {c}
                      </text>
                    )}
                  </For>
                </box>
                <For each={rows}>
                  {(row) => (
                    <box flexDirection="row" gap={2}>
                      <For each={cols}>
                        {(c) => <text fg={theme.text}>{String(row[c] ?? "")}</text>}
                      </For>
                    </box>
                  )}
                </For>
              </scrollbox>
            )
          })()}
        </Match>
      </Switch>
    </box>
  )
}
