// INBOX presentational pieces — the thread list, the open-thread bubble
// view, and the new-chat multi-select overlay. All state/actions live in
// InboxTab.tsx; these only render.

import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"

import { theme } from "../../theme"
import { priorityColor, shortTime, trunc } from "../api"
import { Hint, Section } from "../ui"

export interface Thread {
  tid: string
  subject: string
  preview: string
  priority: string
  unread: number
  ts: string
  relExt: string
}

export interface Msg {
  msgId: string
  fromExt: string
  body: string
  replyEcho: string
  opts: string[]
  replied: boolean
}

export interface NewChat {
  agents: Array<{ ext: string; name: string }>
  selected: string[]
  cursor: number
}

export function ThreadList(props: {
  threads: () => Thread[]
  selected: () => number
  onSelect: (i: number) => void
}) {
  return (
    <>
      <Hint text="↑↓ pick · Enter open · n compose notification · g new chat · r refresh" />
      <Section title="CHATS" />
      <scrollbox flexGrow={1}>
        <For each={props.threads()} fallback={<text fg={theme.textFaint}>No messages yet</text>}>
          {(t, i) => (
            <box
              flexDirection="row"
              gap={1}
              backgroundColor={i() === props.selected() ? theme.surfaceStrong : undefined}
              onMouseDown={() => props.onSelect(i())}
            >
              <text fg={priorityColor(t.priority)} attributes={TextAttributes.BOLD} selectable={false}>
                ({(t.relExt ? t.relExt.charAt(0) : t.tid.slice(0, 2)).toUpperCase()})
              </text>
              <text fg={theme.text}>{t.subject}</text>
              <Show when={t.unread > 0}>
                <text fg={priorityColor(t.priority)} attributes={TextAttributes.BOLD} selectable={false}>
                  [{t.unread > 9 ? "9+" : t.unread}]
                </text>
              </Show>
              <text fg={theme.textFaint}>{shortTime(t.ts)}</text>
              <text fg={theme.textMuted}>{trunc(t.preview, 40)}</text>
            </box>
          )}
        </For>
      </scrollbox>
    </>
  )
}

export function ThreadView(props: {
  thread: Thread
  msgs: () => Msg[]
  threadText: () => string
  optionTarget: () => Msg | null
  onOption: (msgId: string, option: string) => void
}) {
  return (
    <>
      <Hint text="1-9 answer option · i reply · x delete thread · r reload · Esc close" />
      <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
        THREAD · {props.thread.subject}
      </text>
      <Show when={props.threadText()}>
        <text fg={theme.textMuted}>{props.threadText()}</text>
      </Show>
      <scrollbox flexGrow={1}>
        <For each={props.msgs()}>
          {(m) => {
            const out = m.fromExt === "101"
            return (
              <box flexDirection="column" paddingLeft={out ? 4 : 0}>
                <text fg={out ? theme.accent : theme.amber} selectable={false}>
                  {out ? "→" : "←"} ext {m.fromExt}
                </text>
                <text fg={out ? theme.accentBright : theme.text} wrapMode="word">
                  {m.body}
                </text>
                <Show when={m.replyEcho}>
                  <text fg={theme.textFaint}>↪ {m.replyEcho}</text>
                </Show>
                <Show when={m.opts.length > 0 && !m.replied}>
                  <box flexDirection="row" gap={1}>
                    <For each={m.opts}>
                      {(opt, oi) => (
                        <text
                          fg={theme.accentBright}
                          selectable={false}
                          onMouseDown={() => props.onOption(m.msgId, opt)}
                        >
                          [{props.optionTarget()?.msgId === m.msgId ? `${oi() + 1}:` : ""}
                          {opt.replaceAll("_", " ").toUpperCase()}]
                        </text>
                      )}
                    </For>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </>
  )
}

export function NewChatOverlay(props: { nc: NewChat }) {
  return (
    <box flexDirection="column" flexShrink={0} border borderColor={theme.accent}>
      <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
        {props.nc.selected.length > 1 ? `NEW GROUP CHAT · ${props.nc.selected.length}` : "NEW CHAT"}
      </text>
      <For each={props.nc.agents} fallback={<text fg={theme.textFaint}>(no agents)</text>}>
        {(a, i) => (
          <text
            fg={props.nc.selected.includes(a.ext) ? theme.accent : theme.text}
            attributes={i() === props.nc.cursor ? TextAttributes.BOLD : undefined}
          >
            {props.nc.selected.includes(a.ext) ? "✓" : "○"} {a.name} · {a.ext}
          </text>
        )}
      </For>
      <Hint text="↑↓ move · Space toggle · c call first · Enter message · Esc cancel" />
    </box>
  )
}
