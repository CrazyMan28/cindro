// BROWSER page — drive the co-work session's controlled Chrome tab through
// the per-session engine's /browser/* REST surface (the exact routes
// Bridge.cpp:2339-2408 targets; text DOM snapshot instead of a screenshot —
// no lossless terminal image path). BrowserPage.qml parity, including the
// bit the legacy TUI dropped: snapshot rows are SELECTABLE and Enter fires
// /browser/click{ref} (browser_pane.py rendered the list but never wired
// clicking; the GUI clicks; we match the GUI).
//
//   g  edit the URL (Enter navigates, auto-prefixed https://; Esc cancels)
//   b/f back / forward · r refresh the DOM snapshot
//   R  real page reload — POST /browser/reload (an honest reload: the route
//      exists in the engine REST contract, Bridge.cpp:2397 browserReload)
//   ↑↓ select a snapshot row · Enter → /browser/click{ref}
//
// Every call re-reads the CURRENT co-work session id and re-resolves the
// engine endpoint (agent_desktop.info) — the browser_pane.py stale-session
// guard — and a result arriving after the session changed is discarded.

import type { InputRenderable, KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"

import { useApp } from "../app-context"
import { coworkSessionId, engineFetch, resolveEngineEndpoint } from "../engine"
import { theme } from "../theme"

const SNAPSHOT_CAP = 60

interface SnapNode {
  ref: string
  role: string
  name: string
}

export function BrowserPage(props: { active: () => boolean }) {
  const app = useApp()
  const [url, setUrl] = createSignal("")
  const [title, setTitle] = createSignal("")
  const [nodes, setNodes] = createSignal<SnapNode[]>([])
  const [selected, setSelected] = createSignal(0)
  const [status, setStatus] = createSignal("") // failures land HERE, always visible
  const [busy, setBusy] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  let inputRef: InputRenderable | undefined

  const fail = (e: unknown) => setStatus(`✖ ${String(e)}`)

  const enginePost = async (
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    // Fresh session id + fresh endpoint EVERY call (stale-session guard).
    const sid = coworkSessionId()
    if (!sid)
      throw new Error("no active computer-use session — start one on the Computer tab")
    const ep = await resolveEngineEndpoint(app.client, sid)
    const res = await engineFetch(ep.base, path, body, { bearer: ep.bearer })
    if (coworkSessionId() !== sid)
      throw new Error("co-work session changed mid-call — stale result discarded")
    return res
  }

  const applyStatus = (data: Record<string, unknown>) => {
    if (typeof data.url === "string" && data.url) setUrl(data.url)
    if (typeof data.title === "string") setTitle(data.title)
  }

  const refreshSnapshot = async () => {
    const data = await enginePost("/browser/snapshot")
    const list = ((data.nodes ?? []) as Array<Record<string, unknown>>).map((n) => ({
      ref: String(n.ref ?? ""),
      role: String(n.role ?? ""),
      // engine nodes carry "name"; tolerate "text" like BrowserPage.qml does
      name: String(n.name ?? n.text ?? ""),
    }))
    setNodes(list)
    setSelected((i) => Math.min(i, Math.max(0, list.length - 1)))
    applyStatus(data)
  }

  /** navigate/back/forward/reload/click — status fields + a fresh snapshot
   *  (Bridge pulls a fresh screenshot after every nav-ish call; the snapshot
   *  is this page's equivalent surface, and refs go stale on navigation). */
  const navCall = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    setStatus("")
    try {
      applyStatus(await enginePost(path, body))
      await refreshSnapshot()
      setStatus("")
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const navigate = (raw: string) => {
    let u = raw.trim()
    if (!u) return
    if (!u.includes("://") && !u.startsWith("about:")) u = `https://${u}` // QML go()
    void navCall("/browser/navigate", { url: u })
  }

  const startEditing = () => {
    setEditing(true)
    // Focus on the next tick and THEN prefill, so the 'g' that opened the
    // editor can never leak into the field (the Picker mount-grace problem).
    queueMicrotask(() => {
      inputRef?.focus()
      if (inputRef) inputRef.value = url()
    })
  }

  const stopEditing = () => {
    setEditing(false)
    inputRef?.blur()
  }

  const visibleNodes = createMemo(() => nodes().slice(0, SNAPSHOT_CAP))

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || key.ctrl) return
      if (editing()) {
        if (key.name === "escape") {
          key.preventDefault() // ours — don't let the host also act on it
          stopEditing()
        }
        return // the URL input owns every other key while editing
      }
      switch (key.name) {
        case "g":
          startEditing()
          break
        case "b":
          void navCall("/browser/back")
          break
        case "f":
          void navCall("/browser/forward")
          break
        case "r":
          if (key.shift) {
            void navCall("/browser/reload")
          } else {
            setBusy(true)
            setStatus("")
            void refreshSnapshot()
              .catch(fail)
              .finally(() => setBusy(false))
          }
          break
        case "R": // some terminals report shifted letters uppercase
          void navCall("/browser/reload")
          break
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, visibleNodes().length - 1), i + 1))
          break
        case "return": {
          const node = visibleNodes()[selected()]
          if (node?.ref) void navCall("/browser/click", { ref: node.ref })
          break
        }
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          // BROWSER
        </text>
        <text fg={theme.textFaint} selectable={false}>
          g url · b back · f forward · r snapshot · R reload page · ↑↓ row · Enter click
        </text>
        <Show when={busy()}>
          <text fg={theme.amber} selectable={false}>
            …
          </text>
        </Show>
      </box>

      <box
        flexDirection="row"
        height={3}
        flexShrink={0}
        border
        borderColor={editing() ? theme.accent : theme.hairlineSoft}
      >
        <text
          fg={editing() ? theme.accent : theme.textFaint}
          flexShrink={0}
          selectable={false}
        >
          🌐{" "}
        </text>
        <input
          ref={(r: InputRenderable) => {
            inputRef = r
          }}
          flexGrow={1}
          placeholder="https://… (press g to edit)"
          onSubmit={(v: unknown) => {
            stopEditing()
            if (typeof v === "string") navigate(v)
          }}
        />
      </box>

      {/* current title/URL strip */}
      <text fg={theme.textMuted} selectable={false}>
        {title() || url() ? `${title() || "(no title)"} — ${url() || "—"}` : "—"}
      </text>

      <Show
        when={coworkSessionId()}
        fallback={
          <box flexDirection="column" flexGrow={1} paddingTop={1}>
            <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
              NO LIVE SESSION
            </text>
            <text fg={theme.textFaint} wrapMode="word">
              Start a co-worker on the Computer page (key a), then drive its
              controlled browser tab from here.
            </text>
          </box>
        }
      >
        {/* flexBasis 0 is LOAD-BEARING: without it a growing scrollbox's
            intrinsic content size shrinks fixed siblings in opentui 0.3.4 —
            the bottom border of the URL bar gets overdrawn (verified). */}
        <scrollbox flexGrow={1} flexBasis={0}>
          <For
            each={visibleNodes()}
            fallback={
              <text fg={theme.textFaint}>
                (no snapshot — press r to fetch the page's DOM snapshot)
              </text>
            }
          >
            {(node, i) => (
              <box
                flexDirection="row"
                backgroundColor={i() === selected() ? theme.surfaceStrong : undefined}
                onMouseDown={() => setSelected(i())}
              >
                <text
                  fg={i() === selected() ? theme.accentBright : theme.text}
                  selectable={false}
                >
                  [{node.ref}] {node.role}: {node.name}
                </text>
              </box>
            )}
          </For>
          <Show when={nodes().length > SNAPSHOT_CAP}>
            <text fg={theme.textFaint} selectable={false}>
              … {nodes().length - SNAPSHOT_CAP} more nodes (capped at {SNAPSHOT_CAP})
            </text>
          </Show>
        </scrollbox>
      </Show>

      <Show when={status()}>
        <text fg={theme.danger} wrapMode="word">
          {status()}
        </text>
      </Show>
    </box>
  )
}
