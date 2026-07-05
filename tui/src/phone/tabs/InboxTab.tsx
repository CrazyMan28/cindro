// INBOX tab — PhoneInboxTab.qml parity: thread list (priority-colored
// initial, unread badge, timestamp, preview), thread detail (in/out chat
// bubbles, quiz-option reply buttons on number keys, free-text reply,
// delete thread, mark-read on open), compose notification (notify_user),
// and the new-chat multi-select agent picker (direct call or a message
// POSTed to /api/messages per selected agent). Rendering lives in
// InboxViews.tsx; this file owns the state, wire calls and keys.

import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"

import { useApp } from "../../app-context"
import { Picker } from "../../chat/Picker"
import type { Row } from "../api"
import { asList, httpFailure, phoneHttp, phoneMcp, PRIORITIES, str, usePhonePoll } from "../api"
import type { PromptSpec } from "../ui"
import { PromptBar, StatusLine } from "../ui"
import type { TabProps } from "./CallsTab"
import type { Msg, NewChat, Thread } from "./InboxViews"
import { NewChatOverlay, ThreadList, ThreadView } from "./InboxViews"

export function InboxTab(props: TabProps) {
  const app = useApp()
  const [threads, setThreads] = createSignal<Thread[]>([])
  const [selected, setSelected] = createSignal(0)
  const [open, setOpen] = createSignal<Thread | null>(null)
  const [msgs, setMsgs] = createSignal<Msg[]>([])
  const [threadText, setThreadText] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [prompt, setPrompt] = createSignal<PromptSpec | null>(null)
  const [priorityPick, setPriorityPick] = createSignal<{ title: string; msg: string } | null>(null)
  const [newChat, setNewChat] = createSignal<NewChat | null>(null)

  createEffect(() =>
    props.onModalChange?.(prompt() !== null || priorityPick() !== null || newChat() !== null),
  )
  onCleanup(() => props.onModalChange?.(false))

  const refresh = async () => {
    const res = await phoneMcp(app.client, "list_inbox", { limit: 40 })
    if (res.error) {
      setStatus(`list_inbox: ${res.error.message}`)
      return
    }
    const list = asList(res.data, "messages").map((m: Row): Thread => ({
      tid: m.thread_id !== undefined ? str(m.thread_id) : str(m.id),
      subject: m.subject !== undefined ? str(m.subject) : str(m.title) || "(untitled)",
      preview: m.preview !== undefined ? str(m.preview) : str(m.message),
      priority: str(m.priority, "normal"),
      unread: Number(m.unread_count ?? 0),
      ts: str(m.created_at),
      relExt: str(m.related_extension),
    }))
    setThreads(list)
    setSelected((i) => Math.min(i, Math.max(0, list.length - 1)))
  }
  usePhonePoll(app.client, props.active, 8000, refresh)

  const loadThread = async (t: Thread) => {
    setOpen(t)
    setThreadText("Loading…")
    setMsgs([])
    const res = await phoneMcp(app.client, "get_thread_messages", { thread_id: t.tid })
    if (res.error) {
      setThreadText(`Error: ${res.error.message}`)
      return
    }
    const raw = asList(res.data, "messages")
    const unreadIds: string[] = []
    setMsgs(
      raw.map((m: Row): Msg => {
        // Normalize response_options — array or JSON string (QML:91-94).
        let opts: string[] = []
        const rawOpts = m.response_options
        if (Array.isArray(rawOpts)) opts = rawOpts.map(String)
        else if (typeof rawOpts === "string" && rawOpts.length > 0) {
          try {
            const parsed: unknown = JSON.parse(rawOpts)
            if (Array.isArray(parsed)) opts = parsed.map(String)
          } catch {
            opts = []
          }
        }
        if (m.id && (m.status === "queued" || m.status === "delivered")) unreadIds.push(str(m.id))
        return {
          msgId: str(m.id),
          fromExt: str(m.from_extension),
          body: str(m.message) || str(m.content) || str(m.text) || str(m.body),
          replyEcho: str(m.response_text) || str(m.selected_option) || str(m.reply_text),
          opts,
          replied: Boolean(m.response_text || m.selected_option),
        }
      }),
    )
    setThreadText(raw.length > 0 ? "" : "(empty thread)")
    // Fire-and-forget mark-read for unread messages (QML:110-113).
    for (const id of unreadIds) {
      void phoneHttp(app.client, "POST", `/api/messages/${id}/read`).then((r) => {
        const fail = httpFailure(r)
        if (fail) setStatus(`mark-read: ${fail}`)
      })
    }
    if (unreadIds.length > 0) void refresh()
  }

  /** Number keys answer the LAST message that still has open options. */
  const optionTarget = createMemo(() => {
    const list = msgs()
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].opts.length > 0 && !list[i].replied) return list[i]
    }
    return null
  })

  const selectOption = async (msgId: string, option: string) => {
    setStatus("Sending…")
    const res = await phoneHttp(app.client, "POST", `/api/messages/${msgId}/reply`, {
      selected_option: option,
    })
    const fail = httpFailure(res)
    if (fail) setStatus(`Error: ${fail}`)
    else {
      setStatus("")
      const t = open()
      if (t) void loadThread(t)
    }
  }

  const sendFreeReply = async (text: string) => {
    const t = open()
    if (!t || !text.trim()) return
    if (!t.relExt) {
      setStatus("Error: no agent extension for this thread")
      return
    }
    setStatus("Sending…")
    const res = await phoneHttp(app.client, "POST", "/api/messages", {
      to_extension: t.relExt,
      from_extension: "100",
      thread_id: t.tid,
      body: text.trim(),
    })
    const fail = httpFailure(res)
    if (fail) setStatus(`Error: ${fail}`)
    else {
      setStatus("")
      void loadThread(t)
    }
  }

  const deleteThread = async () => {
    const t = open()
    if (!t) return
    const res = await phoneHttp(app.client, "DELETE", `/api/message-threads/${t.tid}`)
    const fail = httpFailure(res)
    if (fail) {
      setStatus(`delete: ${fail}`)
      return
    }
    setOpen(null)
    setMsgs([])
    setThreadText("")
    void refresh()
  }

  const compose = () => {
    setPrompt({
      label: "Notification title",
      onSubmit: (title) => {
        if (!title.trim()) {
          setPrompt(null)
          return
        }
        setPrompt({
          label: "Message",
          onSubmit: (message) => {
            setPrompt(null)
            if (!message.trim()) return
            setPriorityPick({ title: title.trim(), msg: message.trim() })
          },
        })
      },
    })
  }

  const sendNotify = async (title: string, message: string, priority: string) => {
    const res = await phoneMcp(app.client, "notify_user", { title, message, priority })
    setStatus(res.error ? `Error: ${res.error.message}` : "Sent")
    if (!res.error) void refresh()
  }

  const openNewChat = async () => {
    const res = await phoneMcp(app.client, "list_agents")
    if (res.error) {
      setStatus(`list_agents: ${res.error.message}`)
      return
    }
    const agents = asList(res.data).map((a: Row) => ({
      ext: str(a.extension),
      name: str(a.name, "Agent"),
    }))
    setNewChat({ agents, selected: agents.length ? [agents[0].ext] : [], cursor: 0 })
  }

  const startChat = (nc: NewChat) => {
    if (nc.selected.length === 0) return
    setNewChat(null)
    setPrompt({
      label: `First message to ${nc.selected.join(", ")}`,
      onSubmit: (text) => {
        setPrompt(null)
        const body = text.trim()
        if (!body) return
        for (const ext of nc.selected) {
          void phoneHttp(app.client, "POST", "/api/messages", {
            from_extension: "100",
            to_extension: ext,
            body,
            title: "Message",
          }).then((r) => {
            const fail = httpFailure(r)
            if (fail) setStatus(`send to ${ext}: ${fail}`)
            void refresh()
          })
        }
      },
    })
  }

  const handleNewChatKeys = (nc: NewChat, key: KeyEvent) => {
    switch (key.name) {
      case "escape":
        key.preventDefault()
        setNewChat(null)
        break
      case "up":
        setNewChat({ ...nc, cursor: Math.max(0, nc.cursor - 1) })
        break
      case "down":
        setNewChat({ ...nc, cursor: Math.min(nc.agents.length - 1, nc.cursor + 1) })
        break
      case "space": {
        const ext = nc.agents[nc.cursor]?.ext
        if (!ext) break
        const sel = nc.selected.includes(ext)
          ? nc.selected.filter((e) => e !== ext)
          : [...nc.selected, ext]
        setNewChat({ ...nc, selected: sel })
        break
      }
      case "c":
        if (nc.selected.length === 0) break
        setNewChat(null)
        void phoneMcp(app.client, "call_extension", {
          from_extension: "100",
          extension: nc.selected[0],
        }).then((r) => setStatus(r.error ? `Error: ${r.error.message}` : "Calling…"))
        break
      case "return":
        startChat(nc)
        break
      default:
        break
    }
  }

  const handleThreadKeys = (key: KeyEvent) => {
    const n = Number.parseInt(key.name ?? "", 10)
    const target = optionTarget()
    if (target && Number.isInteger(n) && n >= 1 && n <= Math.min(9, target.opts.length)) {
      void selectOption(target.msgId, target.opts[n - 1])
      return
    }
    switch (key.name) {
      case "escape":
        key.preventDefault()
        setOpen(null)
        setMsgs([])
        setStatus("")
        break
      case "i":
        setPrompt({
          label: "Reply to thread",
          onSubmit: (t) => {
            setPrompt(null)
            void sendFreeReply(t)
          },
        })
        break
      case "x":
        void deleteThread()
        break
      case "r": {
        const t = open()
        if (t) void loadThread(t)
        break
      }
      default:
        break
    }
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || priorityPick()) return
      if (prompt()) {
        if (key.name === "escape") {
          key.preventDefault()
          setPrompt(null)
        }
        return
      }
      const nc = newChat()
      if (nc) {
        handleNewChatKeys(nc, key)
        return
      }
      if (open()) {
        handleThreadKeys(key)
        return
      }
      switch (key.name) {
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, threads().length - 1), i + 1))
          break
        case "return": {
          const t = threads()[selected()]
          if (t) void loadThread(t)
          break
        }
        case "n":
          compose()
          break
        case "g":
          void openNewChat()
          break
        case "r":
          void refresh()
          break
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show
        when={open()}
        fallback={<ThreadList threads={threads} selected={selected} onSelect={setSelected} />}
      >
        {(t) => (
          <ThreadView
            thread={t()}
            msgs={msgs}
            threadText={threadText}
            optionTarget={optionTarget}
            onOption={(id, opt) => void selectOption(id, opt)}
          />
        )}
      </Show>

      <Show when={status()}>
        <StatusLine text={status()} />
      </Show>

      <Show when={newChat()}>{(nc) => <NewChatOverlay nc={nc()} />}</Show>

      <Show when={priorityPick()}>
        {(pp) => (
          <Picker
            title="NOTIFICATION PRIORITY"
            options={PRIORITIES.map((p) => ({ label: p.toUpperCase(), value: p }))}
            onPick={(p) => {
              const payload = pp()
              setPriorityPick(null)
              void sendNotify(payload.title, payload.msg, p)
            }}
            onCancel={() => setPriorityPick(null)}
          />
        )}
      </Show>

      <Show when={prompt()} keyed>
        {(p) => <PromptBar prompt={p} />}
      </Show>
    </box>
  )
}
