// The Cindro widget DSL renderer for the Proxmox dashboard — the SAME JSON
// spec desktop/qml's WidgetRenderer.qml, the Android bitmap renderer, and
// web/src/components/WidgetRenderer.tsx (the main app's port) all interpret.
// A safe recursive interpreter; nothing is ever eval'd. This is a dedicated
// copy for the pve/ build (its own Vite entry — see web/vite.pve.config.ts)
// styled with this build's "cx-" class namespace (see ./widgets.css) instead
// of the main app's "w-" classes, and extended with two documented-but-
// previously-web-side-missing pieces of the DSL (see docs/WIDGETS_CANVAS.md):
// stylable containers (bg/radius/border/pad) and per-node `anim`. Node kinds
// (full GUI set): column, row, grid, text, badge, rect, divider, progress,
// spacer, list, canvas, pager, button, link, image, svg.
//
// Security notes (read before changing — mirrors web/src/components/WidgetRenderer.tsx):
//  - sanitizeAction is the SAME allow-list every Cindro frontend enforces
//    (only {send:string} or {skill:string,args?:string} pass through) —
//    never widen this to pass arbitrary objects to onAction.
//  - "svg" renders via <img src="data:image/svg+xml;base64,..."> (exactly
//    how desktop/qml/WidgetRenderer.qml's Image node does it), NEVER via
//    innerHTML — an <img> data URI can't execute embedded <script>/on*
//    handlers the way parsing the markup into live DOM would. Don't "simplify"
//    this to innerHTML; that would turn a widget spec into an XSS vector.
import { createEffect, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"

import { theme } from "../../core/theme"
import "./widgets.css"

export interface WidgetAction {
  send?: string
  skill?: string
  args?: string
}

type Spec = Record<string, unknown>

export function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

function colorOr(v: unknown, fallback: string): string {
  const s = str(v)
  return s ? s : fallback
}

function arr(v: unknown): Spec[] {
  if (Array.isArray(v)) return v as Spec[]
  return []
}

/** ONLY {send} or {skill,args} pass — the same allow-list every Cindro
 * frontend enforces (desktop CanvasPage.handleAction / TUI's sanitizeAction). */
export function sanitizeAction(raw: unknown): WidgetAction | null {
  if (typeof raw !== "object" || raw === null) return null
  const a = raw as Spec
  if (typeof a.send === "string" && a.send) return { send: a.send }
  if (typeof a.skill === "string" && a.skill)
    return { skill: a.skill, args: typeof a.args === "string" ? a.args : "" }
  return null
}

export interface WidgetTreeProps {
  spec: Spec
  onAction?: (action: WidgetAction) => void
}

/** Entry point — render a full widget spec tree. */
export function WidgetTree(props: WidgetTreeProps) {
  return <WidgetNode node={props.spec} onAction={props.onAction} />
}

/** {anim:{type:"pulse"|"fade"|"spin"|"float"|"blink", duration:<ms>}} — a
 * render-only transform wrapper (never disturbs layout), ported from
 * desktop/qml/WidgetRenderer.qml's per-node SequentialAnimation set. */
function AnimWrap(props: { anim: Spec; children: JSX.Element }) {
  const type = () => str(props.anim.type)
  const dur = () => Math.max(120, num(props.anim.duration, 1200))
  return (
    <div class={`cx-anim cx-anim-${type()}`} style={{ "--cx-anim-dur": `${dur()}ms` }}>
      {props.children}
    </div>
  )
}

function WidgetNode(props: { node: unknown; onAction?: (a: WidgetAction) => void }) {
  const node = () => (typeof props.node === "object" && props.node !== null ? (props.node as Spec) : {})
  // The wire DSL keys every node's discriminator as "type" (see
  // docs/WIDGETS_CANVAS.md's spec examples and desktop/qml/WidgetRenderer.qml's
  // own `node.type` read) — NOT "kind". Do not change this back to node().kind;
  // that silently renders every widget as empty nested containers.
  const kind = () => str(node().type, "column")
  const anim = () => (typeof node().anim === "object" && node().anim !== null ? (node().anim as Spec) : null)

  const inner = () => (
    <Switch fallback={<div class="cx-unknown">unsupported widget: {kind()}</div>}>
      <Match when={kind() === "column" || kind() === "row" || kind() === "grid"}>
        <Container node={node()} kind={kind()} onAction={props.onAction} />
      </Match>
      <Match when={kind() === "text"}>
        <Text node={node()} />
      </Match>
      <Match when={kind() === "badge"}>
        <Badge node={node()} />
      </Match>
      <Match when={kind() === "rect"}>
        <RectNode node={node()} />
      </Match>
      <Match when={kind() === "divider"}>
        <hr class="cx-divider" style={{ "border-color": colorOr(node().color, theme.hairlineSoft) }} />
      </Match>
      <Match when={kind() === "progress"}>
        <Progress node={node()} />
      </Match>
      <Match when={kind() === "spacer"}>
        <div
          style={{
            width: `${num(node().w, num(node().size, 8))}px`,
            height: `${num(node().h, num(node().size, 8))}px`,
            flex: "0 0 auto",
          }}
        />
      </Match>
      <Match when={kind() === "list"}>
        <ListNode node={node()} onAction={props.onAction} />
      </Match>
      <Match when={kind() === "canvas"}>
        <CanvasNode node={node()} />
      </Match>
      <Match when={kind() === "pager"}>
        <Pager node={node()} onAction={props.onAction} />
      </Match>
      <Match when={kind() === "button"}>
        <ActionNode node={node()} tag="button" onAction={props.onAction} />
      </Match>
      <Match when={kind() === "link"}>
        <ActionNode node={node()} tag="a" onAction={props.onAction} />
      </Match>
      <Match when={kind() === "image"}>
        <img class="cx-image" src={safeImageUrl(node().url)} alt={str(node().alt, "")} style={imgStyle(node())} />
      </Match>
      <Match when={kind() === "svg"}>
        <SvgNode node={node()} />
      </Match>
    </Switch>
  )

  return (
    <Show when={anim()} fallback={inner()}>
      {(a) => <AnimWrap anim={a()}>{inner()}</AnimWrap>}
    </Show>
  )
}

/** Scheme allow-list for the "image" node — mirrors desktop/qml/WidgetRenderer.qml's
 * linkComp safe-scheme pattern. Only inline data:image/ URIs (generated charts/
 * thumbnails) and http(s) network images are allowed through; anything else
 * (file:, javascript:, etc.) is dropped to an empty src rather than rendered. */
function safeImageUrl(raw: unknown): string {
  const url = str(raw)
  const safe = url.startsWith("data:image/") || url.startsWith("http://") || url.startsWith("https://")
  return safe ? url : ""
}

function imgStyle(node: Spec) {
  const style: Record<string, string> = {}
  if (node.w) style.width = `${num(node.w)}px`
  if (node.h) style.height = `${num(node.h)}px`
  if (node.radius) style["border-radius"] = `${num(node.radius)}px`
  return style
}

/** column/row/grid — a stylable container (bg/radius/border/pad/gap; grid
 * adds cols) that recurses over children. Accepts both the canonical
 * docs/WIDGETS_CANVAS.md keys (pad, cols) and this DSL's original web keys
 * (padding, columns) so specs written for either still render. */
function Container(props: { node: Spec; kind: string; onAction?: (a: WidgetAction) => void }) {
  const children = () => arr(props.node.children ?? props.node.items)
  const pad = () => num(props.node.pad ?? props.node.padding, 0)
  const hasBorder = () => typeof props.node.border === "string" && (props.node.border as string).length > 0
  const shellStyle = () => ({
    background: colorOr(props.node.bg, "transparent"),
    "border-radius": `${num(props.node.radius, 0)}px`,
    border: hasBorder() ? `${num(props.node.borderW, 1)}px solid ${str(props.node.border)}` : "none",
    padding: `${pad()}px`,
  })
  const layoutStyle = () => {
    const gap = `${num(props.node.gap, 8)}px`
    if (props.kind === "grid") {
      const columns = Math.max(1, num(props.node.cols ?? props.node.columns, 2))
      return { display: "grid", "grid-template-columns": `repeat(${columns}, 1fr)`, gap }
    }
    return {
      display: "flex",
      "flex-direction": props.kind === "row" ? "row" : "column",
      gap,
      "flex-wrap": props.node.wrap ? "wrap" : "nowrap",
    }
  }
  return (
    <div class={`cx-${props.kind}`} style={shellStyle() as JSX.CSSProperties}>
      <div style={layoutStyle() as JSX.CSSProperties}>
        <For each={children()}>{(child) => <WidgetNode node={child} onAction={props.onAction} />}</For>
      </div>
    </div>
  )
}

function Text(props: { node: Spec }) {
  const n = props.node
  return (
    <span
      class="cx-text"
      style={{
        color: colorOr(n.color, theme.text),
        "font-size": `${num(n.size, 13)}px`,
        "font-weight": n.bold ? "700" : "400",
        "font-style": n.italic ? "italic" : "normal",
        "text-decoration": n.strike ? "line-through" : "none",
        "text-align": str(n.align, "left") as JSX.CSSProperties["text-align"],
        "font-family": n.mono ? theme.fontMono : n.display ? theme.fontDisplay : theme.fontSans,
      }}
    >
      {str(n.text)}
    </span>
  )
}

function Badge(props: { node: Spec }) {
  const n = props.node
  return (
    <span
      class="cx-badge"
      style={{
        background: colorOr(n.color, theme.accentDim),
        color: colorOr(n.textColor, theme.accentBright),
      }}
    >
      {str(n.text)}
    </span>
  )
}

function RectNode(props: { node: Spec }) {
  const n = props.node
  return (
    <div
      class="cx-rect"
      style={{
        width: n.w ? `${num(n.w)}px` : "100%",
        height: `${num(n.h, 40)}px`,
        background: colorOr(n.fill ?? n.color, theme.accent),
        "border-radius": `${num(n.radius, 0)}px`,
        border: n.stroke ? `1px solid ${str(n.stroke)}` : "none",
      }}
    />
  )
}

function Progress(props: { node: Spec }) {
  const n = props.node
  const pct = () => {
    const v = num(n.value, 0)
    return Math.max(0, Math.min(1, v > 1 ? v / 100 : v)) * 100
  }
  return (
    <div class="cx-progress-track" style={{ background: colorOr(n.trackColor ?? n.track, theme.surface) }}>
      <div class="cx-progress-fill" style={{ width: `${pct()}%`, background: colorOr(n.color, theme.accent) }} />
    </div>
  )
}

/** {rows:[{text,sub,badge,color}]} — the canonical list shape (matches
 * desktop/qml's listComp). Falls back to rendering {items|children} as
 * nested widget nodes for callers using the generic-recursive shape. */
function ListNode(props: { node: Spec; onAction?: (a: WidgetAction) => void }) {
  const rows = () => arr(props.node.rows)
  const items = () => arr(props.node.items ?? props.node.children)
  return (
    <Show
      when={rows().length > 0}
      fallback={
        <div class="cx-list">
          <For each={items()}>{(item) => <WidgetNode node={item} onAction={props.onAction} />}</For>
        </div>
      }
    >
      <div class="cx-list">
        <For each={rows()}>{(row) => <ListRow row={row} />}</For>
      </div>
    </Show>
  )
}

function ListRow(props: { row: Spec }) {
  const r = props.row
  return (
    <div class="cx-list-row">
      <span class="cx-list-accent" style={{ background: colorOr(r.color, theme.accent) }} />
      <div class="cx-list-body">
        <div class="cx-list-text">{str(r.text)}</div>
        <Show when={str(r.sub)}>
          <div class="cx-list-sub">{str(r.sub)}</div>
        </Show>
      </div>
      <Show when={str(r.badge)}>
        <span class="cx-badge cx-list-badge">{str(r.badge)}</span>
      </Show>
    </div>
  )
}

function Pager(props: { node: Spec; onAction?: (a: WidgetAction) => void }) {
  const pages = () => arr(props.node.pages ?? props.node.children)
  const [index, setIndex] = createSignal(0)
  return (
    <div class="cx-pager">
      <div class="cx-pager-content">
        <Show when={pages()[index()]}>{(page) => <WidgetNode node={page()} onAction={props.onAction} />}</Show>
      </div>
      <div class="cx-pager-nav">
        <button type="button" disabled={index() <= 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
          ‹
        </button>
        <span>
          {pages().length ? index() + 1 : 0} / {pages().length}
        </span>
        <button
          type="button"
          disabled={index() >= pages().length - 1}
          onClick={() => setIndex((i) => Math.min(pages().length - 1, i + 1))}
        >
          ›
        </button>
      </div>
    </div>
  )
}

function ActionNode(props: { node: Spec; tag: "button" | "a"; onAction?: (a: WidgetAction) => void }) {
  const n = props.node
  const action = sanitizeAction(n.action)
  const fire = (e: Event) => {
    e.preventDefault()
    if (action) props.onAction?.(action)
  }
  const style = {
    background: colorOr(n.color, theme.accentDim),
    color: colorOr(n.textColor, theme.accentBright),
    "border-radius": `${num(n.radius, 8)}px`,
    "font-size": `${num(n.size, 13)}px`,
  }
  if (props.tag === "a") {
    return (
      <a class="cx-link" href="#" style={style} onClick={fire}>
        {str(n.text)}
      </a>
    )
  }
  return (
    <button type="button" class="cx-button" style={style} onClick={fire}>
      {str(n.text)}
    </button>
  )
}

/** Declarative draw ops, ported 1:1 from WidgetRenderer.qml's canvasComp:
 * circle/ellipse/rect/path/line, each with optional fill/stroke/width. */
function CanvasNode(props: { node: Spec }) {
  let canvas: HTMLCanvasElement | undefined

  const paint = () => {
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const w = num(props.node.w, 120)
    const h = num(props.node.h, 120)
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)
    for (const o of arr(props.node.ops)) {
      const fill = str(o.fill)
      const stroke = str(o.stroke)
      ctx.beginPath()
      switch (str(o.op)) {
        case "circle":
          ctx.arc(num(o.x), num(o.y), Math.max(0, num(o.r)), 0, Math.PI * 2)
          break
        case "ellipse":
          ctx.save()
          ctx.translate(num(o.x), num(o.y))
          ctx.scale(Math.max(0.0001, num(o.rx, 1)), Math.max(0.0001, num(o.ry, 1)))
          ctx.arc(0, 0, 1, 0, Math.PI * 2)
          ctx.restore()
          break
        case "rect": {
          const rr = num(o.radius, 0)
          const rx = num(o.x)
          const ry = num(o.y)
          const rw = num(o.w)
          const rh = num(o.h)
          if (rr > 0 && ctx.roundRect) {
            ctx.roundRect(rx, ry, rw, rh, Math.min(rr, rw / 2, rh / 2))
          } else {
            ctx.rect(rx, ry, rw, rh)
          }
          break
        }
        case "path": {
          const pts = arr(o.points as unknown)
          pts.forEach((pt, i) => {
            const p = pt as unknown as [number, number]
            if (!Array.isArray(p) || p.length < 2) return
            if (i === 0) ctx.moveTo(num(p[0]), num(p[1]))
            else ctx.lineTo(num(p[0]), num(p[1]))
          })
          if (o.close === true) ctx.closePath()
          break
        }
        case "line":
          ctx.moveTo(num(o.x1), num(o.y1))
          ctx.lineTo(num(o.x2), num(o.y2))
          break
        default:
          continue
      }
      if (fill) {
        ctx.fillStyle = fill
        ctx.fill()
      }
      if (stroke || str(o.op) === "line") {
        ctx.strokeStyle = stroke || theme.accent
        ctx.lineWidth = Math.max(0.5, num(o.width, 1.5))
        ctx.lineCap = "round"
        ctx.lineJoin = "round"
        ctx.stroke()
      }
    }
  }

  // createEffect (not onMount) so this also repaints when a later
  // widget.render broadcast updates this node's ops in place (e.g. a live
  // progress/gauge canvas) — paint() reads props.node, so Solid's tracking
  // re-runs it on every prop change, not just once at mount.
  createEffect(paint)

  return (
    <canvas
      ref={(r) => {
        canvas = r
      }}
      width={num(props.node.w, 120)}
      height={num(props.node.h, 120)}
      class="cx-canvas"
    />
  )
}

/** Renders via an <img> data: URI, matching WidgetRenderer.qml's Image node —
 * never via innerHTML (see the file-level security note). */
/** Safe way to render untrusted SVG markup anywhere in the app: an <img>
 * data: URI can't execute embedded <script>/on* handlers the way parsing the
 * markup into live DOM (innerHTML) would. Never render untrusted SVG via
 * innerHTML — use this instead. */
export function svgToDataUri(svg: string): string {
  if (!svg) return ""
  try {
    return `data:image/svg+xml;base64,${btoa(svg)}`
  } catch {
    // btoa throws on non-Latin1 chars; fall back to URI-encoding
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  }
}

function SvgNode(props: { node: Spec }) {
  const dataUri = () => svgToDataUri(str(props.node.svg))
  return (
    <Show when={dataUri()}>
      <img class="cx-svg" src={dataUri()} alt="" style={imgStyle(props.node)} />
    </Show>
  )
}
