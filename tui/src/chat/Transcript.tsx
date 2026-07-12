// <Transcript/> — the chat scrollback. Renders every ChatItem kind the GUI's
// ChatDelegate handles (message/tool/diff/approval/question/widget/error)
// with sticky-bottom autoscroll, a legacy-parity typewriter on live
// assistant messages (3 chars / 12ms ≈ 250 cps, markdown once complete),
// collapsible tool cards (failures auto-expand), and ±-tinted diffs capped
// at 30 lines per file.

import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"

import { syntaxStyle, theme } from "../theme"
import { ArcReactor } from "../ui/ArcReactor"
import { Widget } from "../widgets/Widget"
import type { ChatItem, SessionController } from "./session"

// Word-by-word reveal (the user wants text to "go out word by word" with the
// reactor spitting it): ~3 words per 45ms tick reads as fast, deliberate
// speech rather than a character crawl.
const TYPEWRITER_WORDS = 3
const TYPEWRITER_MS = 45
const MAX_DIFF_LINES = 30
const TOOL_PREVIEW_CHARS = 140

function riskColor(risk: string) {
  if (risk === "high") return theme.danger
  if (risk === "low") return theme.success
  return theme.amber
}

function AssistantMessage(props: { text: string; live: boolean }) {
  // Split into word+whitespace tokens so revealing N words keeps the spacing.
  const tokens = createMemo(() => props.text.match(/\S+\s*/g) ?? [])
  const [shown, setShown] = createSignal(props.live ? 0 : tokens().length)

  onMount(() => {
    if (!props.live) return
    const timer = setInterval(() => {
      setShown((n) => {
        const next = n + TYPEWRITER_WORDS
        if (next >= tokens().length) clearInterval(timer)
        return Math.min(next, tokens().length)
      })
    }, TYPEWRITER_MS)
    onCleanup(() => clearInterval(timer))
  })

  const done = createMemo(() => shown() >= tokens().length)
  return (
    <box flexDirection="column" paddingBottom={1}>
      {/* The reactor sits beside the name and SPINS/THINKS while the words
          are still streaming — it reads as the thing spitting out the text. */}
      <box flexDirection="row" gap={1} alignItems="center">
        <Show when={!done()} fallback={<ArcReactor size={3} spinning={false} />}>
          <ArcReactor size={3} thinking={true} />
        </Show>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
          CINDRO
        </text>
      </box>
      <Show
        when={done()}
        fallback={
          <text fg={theme.text} wrapMode="word">
            {tokens().slice(0, shown()).join("")}
          </text>
        }
      >
        <markdown content={props.text} syntaxStyle={syntaxStyle()} />
      </Show>
    </box>
  )
}

function TodoCard(props: { items: Extract<ChatItem, { kind: "todo" }>["items"] }) {
  const done = () => props.items.filter((t) => t.status === "completed").length
  const glyph = (s: string) => (s === "completed" ? "✔" : s === "in_progress" ? "▶" : "☐")
  const color = (s: string) =>
    s === "completed" ? theme.success : s === "in_progress" ? theme.accentBright : theme.textMuted
  return (
    <box flexDirection="column" paddingBottom={1} border={["left"]} borderColor={theme.accent}>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
          ⏱ To-dos
        </text>
        <text fg={theme.textFaint} selectable={false}>
          {done()}/{props.items.length}
        </text>
      </box>
      <For each={props.items}>
        {(t) => (
          <box flexDirection="row" gap={1} paddingLeft={1}>
            <text fg={color(t.status)} selectable={false}>
              {glyph(t.status)}
            </text>
            <text
              fg={t.status === "completed" ? theme.textFaint : theme.text}
              attributes={t.status === "in_progress" ? TextAttributes.BOLD : undefined}
              wrapMode="word"
            >
              {t.text}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

function SubagentCard(props: {
  item: Extract<ChatItem, { kind: "subagent" }>
  onOpen: (sessionId: string) => void
}) {
  const running = () => props.item.status === "running" || props.item.status === "starting"
  return (
    <box
      flexDirection="column"
      paddingBottom={1}
      border
      borderColor={theme.violet}
      onMouseDown={() => props.item.sessionId && props.onOpen(props.item.sessionId)}
    >
      <box flexDirection="row" gap={1}>
        <Show when={running()} fallback={<text fg={theme.success} selectable={false}>◇</text>}>
          <ArcReactor size={3} thinking={true} />
        </Show>
        <text fg={theme.violet} attributes={TextAttributes.BOLD} selectable={false}>
          subagent: {props.item.name}
        </text>
        <text fg={theme.textFaint} selectable={false}>
          {props.item.status}
        </text>
      </box>
      <Show when={props.item.task}>
        <text fg={theme.textMuted} wrapMode="word" paddingLeft={2}>
          {props.item.task}
        </text>
      </Show>
      <Show when={props.item.sessionId}>
        <text fg={theme.textFaint} selectable={false} paddingLeft={2}>
          click or /agents to watch its chat
        </text>
      </Show>
    </box>
  )
}

function ToolCard(props: { item: Extract<ChatItem, { kind: "tool" }>; onToggle: () => void }) {
  const stateGlyph = () =>
    props.item.state === "running" ? "…" : props.item.state === "ok" ? "✓" : "✕"
  const stateColor = () =>
    props.item.state === "running"
      ? theme.amber
      : props.item.state === "ok"
        ? theme.success
        : theme.danger
  return (
    <box flexDirection="column" onMouseDown={props.onToggle}>
      <box flexDirection="row" gap={1}>
        <text fg={stateColor()} selectable={false}>
          ⚙ {stateGlyph()}
        </text>
        <text fg={theme.amber}>{props.item.name}</text>
        <text fg={theme.textFaint}>{props.item.args.slice(0, TOOL_PREVIEW_CHARS)}</text>
      </box>
      <Show when={props.item.expanded && props.item.output}>
        <box paddingLeft={2} border={["left"]} borderColor={theme.hairlineSoft}>
          <text
            fg={props.item.state === "failed" ? theme.danger : theme.textMuted}
            wrapMode="word"
          >
            {props.item.output.slice(0, 4000)}
          </text>
        </box>
      </Show>
      <Show when={!props.item.expanded && props.item.output}>
        <text fg={theme.textFaint} selectable={false}>
          {"  ↳ "}
          {props.item.output.slice(0, 200).replaceAll("\n", " ⏎ ")}
        </text>
      </Show>
    </box>
  )
}

function DiffCard(props: { item: Extract<ChatItem, { kind: "diff" }> }) {
  const stats = (patch: string) => {
    let add = 0
    let del = 0
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++
      else if (line.startsWith("-") && !line.startsWith("---")) del++
    }
    return { add, del }
  }
  return (
    <box flexDirection="column" paddingBottom={1}>
      <For each={props.item.files}>
        {(file) => {
          const s = stats(file.patch)
          const lines = file.patch.split("\n")
          return (
            <box flexDirection="column">
              <box flexDirection="row" gap={1}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  Δ {file.path || "(unnamed file)"}
                </text>
                <text fg={theme.success}>+{s.add}</text>
                <text fg={theme.danger}>-{s.del}</text>
              </box>
              <For each={lines.slice(0, MAX_DIFF_LINES)}>
                {(line) => (
                  <text
                    fg={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? theme.success
                        : line.startsWith("-") && !line.startsWith("---")
                          ? theme.danger
                          : theme.textMuted
                    }
                  >
                    {line || " "}
                  </text>
                )}
              </For>
              <Show when={lines.length > MAX_DIFF_LINES}>
                <text fg={theme.textFaint}>… {lines.length - MAX_DIFF_LINES} more lines</text>
              </Show>
              <text fg={theme.textFaint} selectable={false}>
                /stage /commit /revert /openpr
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

export function Transcript(props: {
  session: SessionController
  onWidgetAction?: (text: string) => void
  onOpenSubagent?: (sessionId: string) => void
}) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      <For each={props.session.items}>
        {(item) => (
          <Switch>
            <Match when={item.kind === "user"}>
              <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
                ❯ {(item as Extract<ChatItem, { kind: "user" }>).text}
              </text>
            </Match>
            <Match when={item.kind === "assistant"}>
              {(() => {
                const a = item as Extract<ChatItem, { kind: "assistant" }>
                return <AssistantMessage text={a.text} live={a.live} />
              })()}
            </Match>
            <Match when={item.kind === "todo"}>
              <TodoCard items={(item as Extract<ChatItem, { kind: "todo" }>).items} />
            </Match>
            <Match when={item.kind === "subagent"}>
              <SubagentCard
                item={item as Extract<ChatItem, { kind: "subagent" }>}
                onOpen={(sid) => props.onOpenSubagent?.(sid)}
              />
            </Match>
            <Match when={item.kind === "tool"}>
              <ToolCard
                item={item as Extract<ChatItem, { kind: "tool" }>}
                onToggle={() => props.session.toggleTool(item.id)}
              />
            </Match>
            <Match when={item.kind === "diff"}>
              <DiffCard item={item as Extract<ChatItem, { kind: "diff" }>} />
            </Match>
            <Match when={item.kind === "approval"}>
              {(() => {
                const a = item as Extract<ChatItem, { kind: "approval" }>
                return (
                  <box flexDirection="column" border borderColor={riskColor(a.risk)} padding={0}>
                    <text fg={riskColor(a.risk)} attributes={TextAttributes.BOLD}>
                      ✋ AUTHORIZE: {a.summary} [{a.risk}]
                    </text>
                    <Show
                      when={a.resolved}
                      fallback={
                        <text fg={theme.textMuted} selectable={false}>
                          y allow · a always · n deny (or /y /n)
                        </text>
                      }
                    >
                      <text
                        fg={a.resolved === "deny" ? theme.danger : theme.success}
                        selectable={false}
                      >
                        ✓ {a.resolved}
                      </text>
                    </Show>
                  </box>
                )
              })()}
            </Match>
            <Match when={item.kind === "question"}>
              {(() => {
                const q = item as Extract<ChatItem, { kind: "question" }>
                return (
                  <box flexDirection="column" border borderColor={theme.accent}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      ❔ JARVIS ASKS: {q.question}
                    </text>
                    <For each={q.options}>
                      {(opt, i) => (
                        <text fg={theme.text} selectable={false}>
                          {"  "}
                          {i() + 1}. {opt}
                        </text>
                      )}
                    </For>
                    <Show
                      when={q.answered}
                      fallback={
                        <text fg={theme.textFaint} selectable={false}>
                          {q.options.length
                            ? "press 1-9 to pick, or type an answer + Enter"
                            : "type an answer + Enter"}
                        </text>
                      }
                    >
                      <text fg={theme.success} selectable={false}>
                        ✓ {q.answered}
                      </text>
                    </Show>
                  </box>
                )
              })()}
            </Match>
            <Match when={item.kind === "widget"}>
              {(() => {
                const w = item as Extract<ChatItem, { kind: "widget" }>
                return (
                  <box flexDirection="column" border borderColor={theme.hairline}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      ◆ CANVAS · {w.title}
                    </text>
                    <Widget
                      spec={w.spec}
                      onAction={(a) => {
                        if (a.send) props.onWidgetAction?.(a.send)
                        else if (a.skill)
                          props.onWidgetAction?.(`/${a.skill} ${a.args ?? ""}`.trim())
                      }}
                    />
                  </box>
                )
              })()}
            </Match>
            <Match when={item.kind === "error"}>
              <text fg={theme.danger} attributes={TextAttributes.BOLD} wrapMode="word">
                ✖ {(item as Extract<ChatItem, { kind: "error" }>).message}
              </text>
            </Match>
            <Match when={item.kind === "divider"}>
              <text fg={theme.hairline} selectable={false}>
                {"─".repeat(40)}
              </text>
            </Match>
            <Match when={item.kind === "notice"}>
              {(() => {
                const n = item as Extract<ChatItem, { kind: "notice" }>
                const fg =
                  n.style === "error"
                    ? theme.danger
                    : n.style === "warn"
                      ? theme.amber
                      : n.style === "success"
                        ? theme.success
                        : theme.textMuted
                return (
                  <text fg={fg} wrapMode="word">
                    {n.text}
                  </text>
                )
              })()}
            </Match>
          </Switch>
        )}
      </For>
    </scrollbox>
  )
}
