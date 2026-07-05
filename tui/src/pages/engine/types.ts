// Manifest page engine — types + the pure helpers (param substitution, cell
// formatting). The generic TablePage renders ANY manifest "table" page; a
// new daemon feature that fits the shape ships with zero frontend code.

export interface ManifestColumn {
  key: string
  label: string
  format?: "reltime" | "time" | "flag" | "chips" | "risk"
}

export interface ManifestAction {
  id: string
  label: string
  kind?: "verb" | "navigate" | "send_chat"
  verb?: string
  target?: string
  text?: string
  params?: Record<string, unknown>
  confirm?: boolean
  input?: string // action needs free-text input (label for the prompt)
  placeholder?: string
  when?: string // e.g. "archived" / "!builtin" — row-flag gate
  show?: string // "detail" → render the verb result as a detail view
}

export interface ManifestDataSource {
  verb: string
  result_key: string
  params?: Record<string, unknown>
  query_param?: string
}

export interface ManifestPage {
  id: string
  title: string
  section: string
  kind: "table" | "bespoke" | "log" | "markdown" | "widget" | "list"
  source?: string // "custom" for tui.layout pages
  config?: Record<string, unknown> // custom pages carry their config here
  order?: number
  gated_by?: string
  data?: Record<string, ManifestDataSource>
  columns?: ManifestColumn[]
  row_actions?: ManifestAction[]
  page_actions?: ManifestAction[]
  input_actions?: ManifestAction[]
  refresh_events?: string[]
}

export type Row = Record<string, unknown>

/**
 * Resolve an action's params against the selected row:
 *   "$id" → row.id, "$name" → row.name, … "$input" → the provided input
 *   text, "$toggle" → !row.<toggle_field ?: "enabled">.
 */
export function substituteParams(
  params: Record<string, unknown> | undefined,
  row: Row,
  input = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(params ?? {})) {
    if (typeof raw !== "string" || !raw.startsWith("$")) {
      out[key] = raw
      continue
    }
    const token = raw.slice(1)
    if (token === "input") out[key] = input
    else if (token === "toggle") out[key] = !row.enabled
    else out[key] = row[token] ?? ""
  }
  return out
}

/** Row-flag gate: "archived" → row.archived truthy; "!builtin" → falsy. */
export function actionVisible(action: ManifestAction, row: Row): boolean {
  if (!action.when) return true
  const negated = action.when.startsWith("!")
  const flag = negated ? action.when.slice(1) : action.when
  const val = Boolean(row[flag])
  return negated ? !val : val
}

export function formatCell(value: unknown, format?: ManifestColumn["format"]): string {
  if (value === null || value === undefined) return ""
  switch (format) {
    case "flag":
      return value ? "✓" : "·"
    case "chips": {
      const arr = Array.isArray(value) ? value : [value]
      return arr.map((v) => `#${String(v)}`).join(" ")
    }
    case "risk":
      return String(value)
    case "time": {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return String(value)
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }
    case "reltime": {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return ""
      const delta = Date.now() - ms
      const future = delta < 0
      const abs = Math.abs(delta)
      const mins = Math.round(abs / 60000)
      let label: string
      if (mins < 1) label = "now"
      else if (mins < 60) label = `${mins}m`
      else if (mins < 60 * 24) label = `${Math.round(mins / 60)}h`
      else label = `${Math.round(mins / (60 * 24))}d`
      if (label === "now") return label
      return future ? `in ${label}` : `${label} ago`
    }
    default:
      if (typeof value === "object") return JSON.stringify(value)
      return String(value)
  }
}

/** Fixed column widths: fit content, clamp, last column takes the rest. */
export function columnWidths(
  columns: ManifestColumn[],
  rows: Row[],
  total: number,
): number[] {
  const MIN = 4
  const MAX = 40
  const widths = columns.map((c, i) => {
    let w = c.label.length
    for (const row of rows.slice(0, 200)) {
      const len = formatCell(row[c.key], c.format).length
      if (len > w) w = len
    }
    return Math.max(MIN, Math.min(MAX, w + (i < columns.length - 1 ? 2 : 0)))
  })
  // Clamp the sum into the available width, stealing from the widest first.
  let sum = widths.reduce((a, b) => a + b, 0)
  while (sum > total && Math.max(...widths) > MIN) {
    const i = widths.indexOf(Math.max(...widths))
    widths[i]--
    sum--
  }
  return widths
}

export function truncate(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width)
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return `${text.slice(0, width - 1)}…`
}
