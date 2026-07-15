// Operator chat: one persistent session bound to the "proxmox-operator" agent
// and routed at the full-power operator MCP (target_ref "proxmox-op-<host>").
// Renders the Contract B stream (message/thinking/tool/approval) and answers
// permission approvals via approval.respond. Shared by the full Chat page and
// the docked side-rail.

import { For, Show, createSignal, type Component } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Client } from "./client"
import { operatorTargetRef } from "./env"

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; args: string; output: string; ok: boolean; done: boolean }
  | { kind: "approval"; approvalId: string; summary: string; risk: string; resolved: string }
  | { kind: "error"; text: string }

export class ChatController {
  items: ChatItem[]
  private setItems: (fn: (s: ChatItem[]) => void) => void
  private sid = createSignal("")
  busy = createSignal(false)
  private bound = false

  constructor(private client: Client) {
    const [items, setItems] = createStore<ChatItem[]>([])
    this.items = items
    this.setItems = (fn) => setItems(produce(fn))
  }

  sessionId(): string {
    return this.sid[0]()
  }

  bind(): void {
    if (this.bound) return
    this.bound = true
    this.client.on("session.event", (data: any) => {
      if (!data || String(data.session_id ?? "") !== this.sid[0]()) return
      this.apply((data.ev ?? {}) as Record<string, any>)
    })
  }

  private async ensure(): Promise<string> {
    if (this.sid[0]()) return this.sid[0]()
    const r = await this.client.call<any>("session.create", {
      profile: "",
      brain: "api",
      model: "mistral-large-latest",
      agent: "proxmox-operator",
      title: "Proxmox operator",
      target_ref: operatorTargetRef(),
    })
    const id = String(r.session_id ?? "")
    this.sid[1](id)
    if (id) this.client.subscribe(id)
    return id
  }

  async send(text: string): Promise<void> {
    const t = text.trim()
    if (!t) return
    this.setItems((s) => {
      s.push({ kind: "user", text: t })
    })
    this.busy[1](true)
    try {
      const id = await this.ensure()
      await this.client.call("session.send", { session_id: id, text: t }, 30000)
    } catch (e: any) {
      this.busy[1](false)
      this.setItems((s) => {
        s.push({ kind: "error", text: String(e?.message ?? e) })
      })
    }
  }

  async respond(approvalId: string, decision: "allow" | "always" | "deny"): Promise<void> {
    try {
      await this.client.call("approval.respond", {
        session_id: this.sid[0](),
        approval_id: approvalId,
        decision,
      })
    } catch {
      /* ignore */
    }
    this.setItems((s) => {
      for (const it of s)
        if (it.kind === "approval" && it.approvalId === approvalId) it.resolved = decision
    })
  }

  private apply(ev: Record<string, any>): void {
    switch (String(ev.kind ?? "")) {
      case "thinking": {
        const chunk = String(ev.text ?? "")
        this.setItems((s) => {
          const last = s[s.length - 1]
          if (last && last.kind === "thinking") last.text += chunk
          else s.push({ kind: "thinking", text: chunk })
        })
        break
      }
      case "message": {
        if (String(ev.role ?? "") !== "assistant") break
        const text = String(ev.text ?? "")
        this.setItems((s) => {
          s.push({ kind: "assistant", text })
        })
        break
      }
      case "tool_call": {
        const name = String(ev.name ?? "tool")
        let args = ""
        try {
          args = JSON.stringify(ev.args ?? {})
        } catch {
          args = ""
        }
        this.setItems((s) => {
          s.push({ kind: "tool", name, args, output: "", ok: true, done: false })
        })
        break
      }
      case "tool_result": {
        const output = String(ev.output ?? "").trim()
        const ok = ev.ok === undefined ? true : Boolean(ev.ok)
        this.setItems((s) => {
          for (let i = s.length - 1; i >= 0; i--) {
            const it = s[i]
            if (it.kind === "tool" && !it.done) {
              it.output = output
              it.ok = ok
              it.done = true
              break
            }
          }
        })
        break
      }
      case "approval": {
        this.setItems((s) => {
          s.push({
            kind: "approval",
            approvalId: String(ev.approval_id ?? ""),
            summary: String(ev.summary ?? ev.tool ?? "an action"),
            risk: String(ev.risk ?? "medium"),
            resolved: "",
          })
        })
        break
      }
      case "error": {
        this.busy[1](false)
        this.setItems((s) => {
          s.push({ kind: "error", text: String(ev.message ?? "error") })
        })
        break
      }
      case "final": {
        this.busy[1](false)
        break
      }
    }
  }
}

const ApprovalCard: Component<{
  item: Extract<ChatItem, { kind: "approval" }>
  onRespond: (d: "allow" | "always" | "deny") => void
}> = (props) => (
  <div class={`px-approval risk-${props.item.risk}`}>
    <div class="px-approval-head">
      ✋ AUTHORIZE <span class="px-approval-risk">[{props.item.risk}]</span>
    </div>
    <div class="px-approval-body">{props.item.summary}</div>
    <Show
      when={!props.item.resolved}
      fallback={<div class="px-approval-done">— {props.item.resolved}</div>}
    >
      <div class="px-approval-actions">
        <button class="px-btn px-btn-ok" onClick={() => props.onRespond("allow")}>Allow</button>
        <button class="px-btn" onClick={() => props.onRespond("always")}>Always</button>
        <button class="px-btn px-btn-danger" onClick={() => props.onRespond("deny")}>Deny</button>
      </div>
    </Show>
  </div>
)

export const ChatPanel: Component<{ controller: ChatController; compact?: boolean }> = (props) => {
  const [draft, setDraft] = createSignal("")
  const submit = () => {
    const t = draft()
    if (!t.trim()) return
    setDraft("")
    void props.controller.send(t)
  }
  return (
    <div class={`px-chat ${props.compact ? "px-chat-compact" : ""}`}>
      <div class="px-chat-scroll">
        <For each={props.controller.items}>
          {(it) => (
            <Show when={it.kind === "approval"} fallback={<ChatBubble item={it} />}>
              <ApprovalCard
                item={it as Extract<ChatItem, { kind: "approval" }>}
                onRespond={(d) =>
                  props.controller.respond((it as any).approvalId, d)
                }
              />
            </Show>
          )}
        </For>
        <Show when={props.controller.busy[0]()}>
          <div class="px-busy">Jarvis is working…</div>
        </Show>
      </div>
      <div class="px-composer">
        <textarea
          class="px-input"
          placeholder="Ask Jarvis to manage Proxmox…"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button class="px-btn px-btn-ok" onClick={submit}>Send</button>
      </div>
    </div>
  )
}

const ChatBubble: Component<{ item: ChatItem }> = (props) => {
  const it = props.item
  if (it.kind === "user") return <div class="px-msg px-msg-user">{it.text}</div>
  if (it.kind === "assistant") return <div class="px-msg px-msg-assistant">{it.text}</div>
  if (it.kind === "thinking")
    return <div class="px-msg px-msg-thinking">{it.text}</div>
  if (it.kind === "error") return <div class="px-msg px-msg-error">{it.text}</div>
  if (it.kind === "tool")
    return (
      <div class={`px-tool ${it.done ? (it.ok ? "ok" : "fail") : "running"}`}>
        <div class="px-tool-head">
          <span class="px-tool-name">{it.name}</span>
          <span class="px-tool-status">{it.done ? (it.ok ? "✓" : "✗") : "…"}</span>
        </div>
        <Show when={it.done && it.output}>
          <pre class="px-tool-out">{it.output.slice(0, 1200)}</pre>
        </Show>
      </div>
    )
  return null
}
