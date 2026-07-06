// INBOX — SMS/agent-message thread list + detail, ported from
// desktop/qml/PhoneInboxTab.qml: priority-badged thread list (avatar initial,
// unread count, timestamp, preview), thread detail (in/out chat bubbles,
// response-option pill buttons, free-text reply, mark-read-on-open, delete
// thread), a compose-notification card (notify_user), and a new-chat overlay
// that multi-selects agents to either call or message.
//
// Both `list_inbox`/`get_thread_messages`/`notify_user`/`list_agents`/
// `call_extension` (phone.mcp) and the REST-shaped message endpoints
// (phone.http: POST/DELETE /api/messages*) are the exact call shapes used by
// tui/src/phone/api.ts + tabs/InboxTab.tsx (the closest non-Qt reference) —
// ported here rather than re-derived, since jarvisd holds the phone bearer
// and proxies both verbs identically for every frontend.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { ControlClient } from "../../core/control-client"
import { NavIcon } from "../../components/NavIcon"
import { PhoneTabPanel, usePhoneTab } from "./index"

// ---------------------------------------------------------------------------
// phone.mcp / phone.http wrappers — mirrors tui/src/phone/api.ts's contract
// (transport failures fold into the same {error} shape the QML/TUI already
// check, so every failure surfaces as visible text, never a silent no-op).
// ---------------------------------------------------------------------------

interface PhoneErr {
  code: string
  message: string
}
interface McpRes {
  tool?: string
  data?: unknown
  error?: PhoneErr
}
interface HttpRes {
  status?: number
  data?: unknown
  error?: PhoneErr
}

async function phoneMcp(client: ControlClient, name: string, args: Record<string, unknown> = {}): Promise<McpRes> {
  try {
    return (await client.call("phone.mcp", { name, arguments: args }, 30000)) as McpRes
  } catch (e) {
    return { tool: name, error: { code: "transport_error", message: String(e) } }
  }
}

async function phoneHttp(
  client: ControlClient,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<HttpRes> {
  try {
    return (await client.call("phone.http", { method, path, body }, 30000)) as HttpRes
  } catch (e) {
    return { status: 0, error: { code: "transport_error", message: String(e) } }
  }
}

/** Failure message for an http result, or null when it succeeded — a >=400
 * status is a failure here (not silently treated as success). */
function httpFailure(res: HttpRes): string | null {
  if (res.error) return res.error.message
  const status = res.status ?? 0
  if (status >= 400 || status === 0) {
    const data = (res.data ?? {}) as Record<string, unknown>
    return String(data.error ?? data.message ?? `HTTP ${status}`)
  }
  return null
}

type Row = Record<string, unknown>

function asList(data: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(data)) return data as Row[]
  if (typeof data === "object" && data !== null) {
    for (const k of keys) {
      const v = (data as Row)[k]
      if (Array.isArray(v)) return v as Row[]
    }
  }
  return []
}

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

/** PhoneInboxTab.qml:273 thread-list timestamp shortener. */
function shortTime(ts: string): string {
  return ts.length > 5 ? ts.slice(-8).slice(0, 5) : ts
}

const PRIORITIES = ["low", "normal", "urgent", "critical"]

/** PhoneInboxTab.qml:237-239 priority colors. */
function priorityColor(p: string): string {
  if (p === "critical") return "var(--danger)"
  if (p === "urgent") return "var(--amber)"
  if (p === "low") return "var(--text-faint)"
  return "var(--accent)"
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

interface Thread {
  tid: string
  subject: string
  preview: string
  priority: string
  unread: number
  ts: string
  relExt: string
}

interface Msg {
  msgId: string
  fromExt: string
  body: string
  replyEcho: string
  opts: string[]
  replied: boolean
}

interface AgentRow {
  ext: string
  name: string
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function PhoneInboxTab() {
  const app = useApp()
  const ctx = usePhoneTab()

  const [threads, setThreads] = createSignal<Thread[]>([])
  const [open, setOpen] = createSignal<Thread | null>(null)
  const [msgs, setMsgs] = createSignal<Msg[]>([])
  const [threadText, setThreadText] = createSignal("")
  const [replyStatus, setReplyStatus] = createSignal("")
  const [replyDraft, setReplyDraft] = createSignal("")

  const [nTitle, setNTitle] = createSignal("")
  const [nMsg, setNMsg] = createSignal("")
  const [nPriority, setNPriority] = createSignal("normal")
  const [notifyStatus, setNotifyStatus] = createSignal("")

  const [showNewChat, setShowNewChat] = createSignal(false)
  const [ncAgents, setNcAgents] = createSignal<AgentRow[]>([])
  const [ncSelected, setNcSelected] = createSignal<string[]>([])
  const [ncMsg, setNcMsg] = createSignal("")
  const [ncBusy, setNcBusy] = createSignal(false)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const refresh = async () => {
    const res = await phoneMcp(app.client, "list_inbox", { limit: 40 })
    if (!alive) return
    if (res.error) {
      app.notify(`inbox: ${res.error.message}`, "warn")
      return
    }
    const list = asList(res.data, "messages").map(
      (m): Thread => ({
        tid: m.thread_id !== undefined ? str(m.thread_id) : str(m.id),
        subject: m.subject !== undefined ? str(m.subject) : str(m.title) || "(untitled)",
        preview: m.preview !== undefined ? str(m.preview) : str(m.message),
        priority: str(m.priority, "normal"),
        unread: Number(m.unread_count ?? 0),
        ts: str(m.created_at),
        relExt: str(m.related_extension),
      }),
    )
    setThreads(list)
  }

  // Initial load + reacts to the shell's refresh button (usePhoneTab contract).
  createEffect(() => {
    ctx.refreshNonce()
    void refresh()
  })
  // Background cadence, matching PhonePane's inbox poll interval.
  onMount(() => {
    const timer = setInterval(() => void refresh(), 8000)
    onCleanup(() => clearInterval(timer))
  })

  const loadThread = async (t: Thread) => {
    setOpen(t)
    setThreadText("Loading…")
    setMsgs([])
    setReplyStatus("")
    setReplyDraft("")
    const res = await phoneMcp(app.client, "get_thread_messages", { thread_id: t.tid })
    if (!alive) return
    if (res.error) {
      setThreadText(`Error: ${res.error.message}`)
      return
    }
    const raw = asList(res.data, "messages")
    const unreadIds: string[] = []
    const parsed = raw.map((m): Msg => {
      let opts: string[] = []
      const rawOpts = m.response_options
      if (Array.isArray(rawOpts)) opts = rawOpts.map(String)
      else if (typeof rawOpts === "string" && rawOpts.length > 0) {
        try {
          const parsedOpts: unknown = JSON.parse(rawOpts)
          if (Array.isArray(parsedOpts)) opts = parsedOpts.map(String)
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
    })
    setMsgs(parsed)
    setThreadText(parsed.length > 0 ? "" : "(empty thread)")
    // Best-effort mark-read for anything still queued/delivered — optimistic
    // locally either way, but log a failure so a desynced unread badge is at
    // least diagnosable instead of silently vanishing.
    for (const id of unreadIds) {
      void phoneHttp(app.client, "POST", `/api/messages/${id}/read`).then((res) => {
        const fail = httpFailure(res)
        if (fail) console.warn(`mark-read failed for message ${id}: ${fail}`)
      })
    }
    if (unreadIds.length > 0) void refresh()
  }

  const closeThread = () => {
    setOpen(null)
    setMsgs([])
    setThreadText("")
    setReplyStatus("")
    setReplyDraft("")
  }

  const optionTarget = createMemo(() => {
    const list = msgs()
    for (let i = list.length - 1; i >= 0; i--) if (list[i].opts.length > 0 && !list[i].replied) return list[i]
    return null
  })

  const selectOption = async (msgId: string, option: string) => {
    setReplyStatus("Sending…")
    const res = await phoneHttp(app.client, "POST", `/api/messages/${msgId}/reply`, { selected_option: option })
    const fail = httpFailure(res)
    if (fail) {
      setReplyStatus(`Error: ${fail}`)
      return
    }
    setReplyStatus("")
    const t = open()
    if (t) void loadThread(t)
  }

  const sendFreeReply = async () => {
    const t = open()
    const text = replyDraft().trim()
    if (!t || !text) return
    if (!t.relExt) {
      setReplyStatus("Error: no agent extension for this thread")
      return
    }
    setReplyStatus("Sending…")
    const res = await phoneHttp(app.client, "POST", "/api/messages", {
      to_extension: t.relExt,
      from_extension: "100",
      thread_id: t.tid,
      body: text,
    })
    const fail = httpFailure(res)
    if (fail) {
      setReplyStatus(`Error: ${fail}`)
      return
    }
    setReplyStatus("")
    setReplyDraft("")
    void loadThread(t)
  }

  const deleteThread = async () => {
    const t = open()
    if (!t) return
    const res = await phoneHttp(app.client, "DELETE", `/api/message-threads/${t.tid}`)
    const fail = httpFailure(res)
    if (fail) {
      setReplyStatus(`delete: ${fail}`)
      return
    }
    closeThread()
    void refresh()
  }

  const sendNotify = async () => {
    const title = nTitle().trim()
    const message = nMsg().trim()
    if (!title || !message) return
    const res = await phoneMcp(app.client, "notify_user", { title, message, priority: nPriority() })
    setNotifyStatus(res.error ? `Error: ${res.error.message}` : "Sent")
    if (!res.error) {
      setNTitle("")
      setNMsg("")
      void refresh()
    }
  }

  const openNewChat = async () => {
    setShowNewChat(true)
    setNcMsg("")
    setNcBusy(true)
    const res = await phoneMcp(app.client, "list_agents")
    if (!alive) return
    setNcBusy(false)
    if (res.error) {
      app.notify(`list_agents: ${res.error.message}`, "warn")
      setNcAgents([])
      return
    }
    const agents = asList(res.data).map((a): AgentRow => ({ ext: str(a.extension), name: str(a.name, "Agent") }))
    setNcAgents(agents)
    setNcSelected(agents.length ? [agents[0].ext] : [])
  }

  const toggleNcAgent = (ext: string) => {
    setNcSelected((sel) => (sel.includes(ext) ? sel.filter((e) => e !== ext) : [...sel, ext]))
  }

  const callFirstSelected = async () => {
    const sel = ncSelected()
    if (sel.length === 0) return
    const res = await phoneMcp(app.client, "call_extension", { from_extension: "100", extension: sel[0] })
    if (res.error) {
      app.notify(`Call failed: ${res.error.message}`, "error")
      return
    }
    setShowNewChat(false)
  }

  const startChat = async () => {
    const sel = ncSelected()
    const msg = ncMsg().trim()
    if (sel.length === 0 || !msg) return
    const results = await Promise.all(
      sel.map((ext) =>
        phoneHttp(app.client, "POST", "/api/messages", {
          from_extension: "100",
          to_extension: ext,
          body: msg,
          title: "Message",
        }),
      ),
    )
    const failures = results.map(httpFailure).filter((f): f is string => Boolean(f))
    if (failures.length > 0) {
      app.notify(`Message failed to send to ${failures.length} agent(s): ${failures[0]}`, "error")
      return
    }
    setShowNewChat(false)
    void refresh()
  }

  return (
    <PhoneTabPanel>
      <div class="inbox-page">
        <div class="inbox-topbar">
          <NavIcon glyph="chat" color="var(--accent)" glow />
          <span class="hud-label inbox-topbar-title">CHATS</span>
          <span class="inbox-topbar-count">{threads().length}</span>
          <div style={{ flex: 1 }} />
          <button type="button" class="inbox-icon-btn" title="New chat" onClick={() => void openNewChat()}>
            +
          </button>
        </div>

        <div class="inbox-threadlist" classList={{ compact: Boolean(open()) }}>
          <Show
            when={threads().length > 0}
            fallback={
              <div class="inbox-empty">
                <div class="inbox-empty-glyph">📥</div>
                <div>No messages yet</div>
              </div>
            }
          >
            <For each={threads()}>
              {(t) => {
                const pColor = () => priorityColor(t.priority)
                const initial = () => (t.relExt ? t.relExt.charAt(0) : t.tid.slice(0, 2)).toUpperCase()
                return (
                  <button
                    type="button"
                    class="inbox-thread-row"
                    classList={{ active: open()?.tid === t.tid }}
                    onClick={() => void loadThread(t)}
                  >
                    <span class="inbox-avatar" style={{ color: pColor(), "border-color": pColor() }}>
                      {initial()}
                    </span>
                    <span class="inbox-thread-mid">
                      <span class="inbox-thread-top">
                        <span class="inbox-thread-subject">{t.subject}</span>
                        <span class="inbox-thread-ts">{shortTime(t.ts)}</span>
                      </span>
                      <span class="inbox-thread-preview">{t.preview}</span>
                    </span>
                    <Show when={t.unread > 0}>
                      <span class="inbox-unread-badge" style={{ background: pColor() }}>
                        {t.unread > 9 ? "9+" : t.unread}
                      </span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </Show>
        </div>

        <Show when={open()}>
          {(t) => (
            <div class="inbox-detail card">
              <div class="inbox-detail-header">
                <span class="inbox-detail-subject">{t().subject || "Thread"}</span>
                <Show when={replyStatus()}>
                  <span class={replyStatus().startsWith("Error") ? "inbox-status err" : "inbox-status"}>
                    {replyStatus()}
                  </span>
                </Show>
                <button type="button" class="inbox-del-btn" onClick={() => void deleteThread()}>
                  DEL
                </button>
                <button type="button" class="inbox-close-btn" onClick={closeThread}>
                  ✕
                </button>
              </div>

              <Show when={msgs().length === 0 && threadText()}>
                <div class="inbox-thread-loading">{threadText()}</div>
              </Show>

              <div class="inbox-bubbles">
                <For each={msgs()}>
                  {(m) => {
                    const out = m.fromExt === "101"
                    const showOpts = m.opts.length > 0 && !m.replied
                    return (
                      <div class="inbox-bubble-row" classList={{ out }}>
                        <div class="inbox-bubble" classList={{ out }}>
                          <div class="inbox-bubble-body">{m.body}</div>
                          <Show when={m.replyEcho}>
                            <div class="inbox-bubble-echo">↪ {m.replyEcho}</div>
                          </Show>
                          <Show when={showOpts}>
                            <div class="inbox-opts">
                              <For each={m.opts}>
                                {(opt) => (
                                  <button type="button" class="inbox-opt-btn" onClick={() => void selectOption(m.msgId, opt)}>
                                    {opt.replace(/_/g, " ").toUpperCase()}
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>

              <div class="inbox-reply-row">
                <input
                  class="inbox-input"
                  placeholder="Reply to thread…"
                  value={replyDraft()}
                  onInput={(e) => setReplyDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void sendFreeReply()
                  }}
                />
                <button type="button" class="inbox-send-btn" onClick={() => void sendFreeReply()}>
                  SEND
                </button>
              </div>
              <Show when={optionTarget()}>
                <div class="inbox-hint">Tip: this thread has an unanswered prompt — tap an option above.</div>
              </Show>
            </div>
          )}
        </Show>

        <div class="inbox-compose card">
          <div class="hud-label inbox-compose-title">COMPOSE NOTIFICATION</div>
          <input
            class="inbox-input"
            placeholder="Title"
            value={nTitle()}
            onInput={(e) => setNTitle(e.currentTarget.value)}
          />
          <input
            class="inbox-input"
            placeholder="Message"
            value={nMsg()}
            onInput={(e) => setNMsg(e.currentTarget.value)}
          />
          <div class="inbox-compose-row">
            <div class="inbox-priority-pills">
              <For each={PRIORITIES}>
                {(p) => (
                  <button
                    type="button"
                    class="inbox-priority-pill"
                    classList={{ active: nPriority() === p }}
                    onClick={() => setNPriority(p)}
                  >
                    {p.toUpperCase()}
                  </button>
                )}
              </For>
            </div>
            <div style={{ flex: 1 }} />
            <button type="button" class="inbox-send-btn" onClick={() => void sendNotify()}>
              SEND
            </button>
          </div>
          <Show when={notifyStatus()}>
            <div class="inbox-status ok">{notifyStatus()}</div>
          </Show>
        </div>
      </div>

      <Show when={showNewChat()}>
        <div
          class="inbox-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowNewChat(false)
          }}
        >
          <div class="inbox-modal">
            <div class="inbox-modal-title">
              {ncSelected().length > 1 ? `New group chat · ${ncSelected().length}` : "New chat"}
            </div>
            <div class="inbox-modal-sub">Tap one or more agents</div>
            <div class="inbox-modal-agents">
              <Show when={!ncBusy()} fallback={<div class="inbox-empty">Loading agents…</div>}>
                <Show when={ncAgents().length > 0} fallback={<div class="inbox-empty">No agents found.</div>}>
                  <For each={ncAgents()}>
                    {(a) => {
                      const sel = () => ncSelected().includes(a.ext)
                      return (
                        <button
                          type="button"
                          class="inbox-modal-agent-row"
                          classList={{ selected: sel() }}
                          onClick={() => toggleNcAgent(a.ext)}
                        >
                          <span>{sel() ? "✓" : "○"}</span>
                          <span>
                            {a.name} · {a.ext}
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </Show>
              </Show>
            </div>
            <input
              class="inbox-input"
              placeholder="First message…"
              value={ncMsg()}
              onInput={(e) => setNcMsg(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void startChat()
              }}
            />
            <div class="inbox-modal-actions">
              <button type="button" class="inbox-modal-cancel" onClick={() => setShowNewChat(false)}>
                CANCEL
              </button>
              <button type="button" class="inbox-modal-call" onClick={() => void callFirstSelected()}>
                📞 CALL
              </button>
              <button type="button" class="inbox-modal-start" onClick={() => void startChat()}>
                START
              </button>
            </div>
          </div>
        </div>
      </Show>

      <style>{INBOX_CSS}</style>
    </PhoneTabPanel>
  )
}

// ---------------------------------------------------------------------------
// styles — page-scoped (inbox-* prefix); tokens from theme.css
// ---------------------------------------------------------------------------

const INBOX_CSS = `
.inbox-page { display: flex; flex-direction: column; gap: 12px; }
.inbox-topbar { display: flex; align-items: center; gap: 8px; }
.inbox-topbar-title { font-size: 11px; color: var(--text-faint); }
.inbox-topbar-count { font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.inbox-icon-btn {
  all: unset;
  cursor: pointer;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-xs);
  border: 1px solid var(--accent-dim);
  color: var(--accent);
  font-size: 16px;
  transition: background var(--dur-fast) ease;
}
.inbox-icon-btn:hover { background: var(--accent-dim); }

.inbox-threadlist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 420px;
  overflow-y: auto;
  padding: 2px;
}
.inbox-threadlist.compact { max-height: 190px; }
.inbox-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; padding: 32px 0; color: var(--text-faint); font-size: 12px;
}
.inbox-empty-glyph { font-size: 30px; opacity: 0.6; }

.inbox-thread-row {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-soft);
  background: var(--surface);
  transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, transform var(--dur-fast) ease;
  animation: inbox-row-in var(--dur-slow) ease-out backwards;
}
@keyframes inbox-row-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.inbox-thread-row:hover { background: var(--surface-strong); transform: translateX(2px); }
.inbox-thread-row.active { border-color: var(--accent-dim); box-shadow: 0 0 12px -4px var(--accent-glow); }
.inbox-avatar {
  flex-shrink: 0;
  width: 36px; height: 36px;
  border-radius: 50%;
  border: 1px solid;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  background: rgba(255,255,255,0.03);
}
.inbox-thread-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.inbox-thread-top { display: flex; align-items: baseline; gap: 6px; }
.inbox-thread-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text); font-weight: 500; }
.inbox-thread-ts { font-size: 9px; color: var(--text-faint); font-family: var(--font-mono); flex-shrink: 0; }
.inbox-thread-preview { font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inbox-unread-badge {
  flex-shrink: 0;
  min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  color: var(--ink-on-accent);
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
}

.inbox-detail { display: flex; flex-direction: column; gap: 8px; }
.inbox-detail-header { display: flex; align-items: center; gap: 8px; }
.inbox-detail-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text); font-weight: 500; }
.inbox-status { font-size: 10px; color: var(--accent); font-family: var(--font-mono); }
.inbox-status.err { color: var(--danger); }
.inbox-status.ok { color: var(--success); }
.inbox-del-btn, .inbox-close-btn {
  all: unset;
  cursor: pointer;
  height: 22px;
  padding: 0 8px;
  border-radius: 4px;
  border: 1px solid var(--hairline-soft);
  color: var(--text-faint);
  font-family: var(--font-display);
  font-size: 9px;
  letter-spacing: 0.6px;
  display: flex; align-items: center; justify-content: center;
}
.inbox-del-btn:hover { border-color: var(--danger); color: var(--danger); background: var(--danger-dim); }
.inbox-close-btn:hover { color: var(--text); background: rgba(255,255,255,0.08); }
.inbox-thread-loading { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }

.inbox-bubbles {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 2px;
}
.inbox-bubble-row { display: flex; }
.inbox-bubble-row.out { justify-content: flex-end; }
.inbox-bubble {
  max-width: 80%;
  border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft);
  background: var(--surface-strong);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.inbox-bubble.out { border-color: var(--accent-dim); background: var(--accent-dim); }
.inbox-bubble-body { font-size: 11px; color: var(--text); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.inbox-bubble.out .inbox-bubble-body { color: var(--accent-bright); }
.inbox-bubble-echo { font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.inbox-opts { display: flex; flex-wrap: wrap; gap: 4px; }
.inbox-opt-btn {
  all: unset;
  cursor: pointer;
  height: 22px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--accent);
  background: var(--accent-dim);
  color: var(--accent-bright);
  font-family: var(--font-display);
  font-size: 8px;
  letter-spacing: 0.6px;
  display: flex; align-items: center;
  transition: background var(--dur-fast) ease, color var(--dur-fast) ease;
}
.inbox-opt-btn:hover { background: var(--accent); color: var(--ink-on-accent); }

.inbox-reply-row { display: flex; gap: 6px; }
.inbox-hint { font-size: 10px; color: var(--text-faint); }

.inbox-input {
  all: unset;
  box-sizing: border-box;
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft);
  background: var(--surface-input);
  color: var(--text);
  font-size: 12px;
}
.inbox-input:focus { border-color: var(--accent); }
.inbox-input::placeholder { color: var(--text-faint); }

.inbox-send-btn {
  all: unset;
  cursor: pointer;
  height: 32px;
  padding: 0 16px;
  border-radius: var(--radius-xs);
  background: var(--accent-dim);
  color: var(--accent-bright);
  font-family: var(--font-display);
  font-size: 10px;
  letter-spacing: 1.2px;
  font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  transition: background var(--dur-fast) ease;
}
.inbox-send-btn:hover { background: var(--accent); color: var(--ink-on-accent); }

.inbox-compose { display: flex; flex-direction: column; gap: 8px; }
.inbox-compose-title { font-size: 10px; color: var(--text-faint); }
.inbox-compose-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.inbox-priority-pills { display: flex; gap: 4px; flex-wrap: wrap; }
.inbox-priority-pill {
  all: unset;
  cursor: pointer;
  height: 22px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft);
  color: var(--text-muted);
  font-family: var(--font-display);
  font-size: 8px;
  letter-spacing: 0.6px;
  display: flex; align-items: center;
}
.inbox-priority-pill.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent-bright); }

.inbox-modal-backdrop {
  position: fixed; inset: 0; z-index: 250;
  background: rgba(4,7,12,0.65);
  display: flex; align-items: center; justify-content: center;
}
.inbox-modal {
  width: min(420px, calc(100vw - 48px));
  background: var(--surface-strong);
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 20px 50px -14px rgba(0,0,0,0.6);
}
.inbox-modal-title { font-size: 14px; color: var(--text); font-weight: 500; }
.inbox-modal-sub { font-size: 11px; color: var(--text-faint); }
.inbox-modal-agents { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; }
.inbox-modal-agent-row {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
.inbox-modal-agent-row:hover { background: rgba(255,255,255,0.05); }
.inbox-modal-agent-row.selected { border-color: var(--accent); background: var(--accent-dim); color: var(--accent-bright); }
.inbox-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
.inbox-modal-cancel, .inbox-modal-call, .inbox-modal-start {
  all: unset;
  cursor: pointer;
  height: 30px;
  padding: 0 14px;
  border-radius: var(--radius-xs);
  font-family: var(--font-display);
  font-size: 9px;
  letter-spacing: 0.8px;
  display: flex; align-items: center; justify-content: center;
}
.inbox-modal-cancel { border: 1px solid var(--hairline-soft); color: var(--text-muted); }
.inbox-modal-cancel:hover { background: rgba(255,255,255,0.08); }
.inbox-modal-call { border: 1px solid var(--accent-dim); color: var(--accent); }
.inbox-modal-call:hover { background: var(--accent-dim); }
.inbox-modal-start { background: var(--accent-dim); color: var(--accent-bright); font-weight: 600; }
.inbox-modal-start:hover { background: var(--accent); color: var(--ink-on-accent); }
`
