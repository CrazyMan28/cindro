// Resolved theme — tokens.ts hex values lifted into @opentui RGBA once.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { RGBA, SyntaxStyle } from "@opentui/core"

import { configDir } from "../config"
import { risk, tokens } from "./tokens"

function hex(v: string): RGBA {
  return RGBA.fromHex(v)
}

export const theme = {
  bg: hex(tokens.bgTop),
  bgDeep: hex(tokens.bgDeep),
  surface: hex(tokens.surface),
  surfaceStrong: hex(tokens.surfaceStrong),
  hairline: hex(tokens.hairline),
  hairlineSoft: hex(tokens.hairlineSoft),
  hairlineFaint: hex(tokens.hairlineFaint),

  accent: hex(tokens.accent),
  accentBright: hex(tokens.accentBright),
  accent2: hex(tokens.accent2),
  accentDeep: hex(tokens.accentDeep),

  amber: hex(tokens.amber),
  violet: hex(tokens.violet),
  magenta: hex(tokens.magenta),
  success: hex(tokens.success),
  danger: hex(tokens.danger),

  text: hex(tokens.text),
  textMuted: hex(tokens.textMuted),
  textFaint: hex(tokens.textFaint),
  inkOnAccent: hex(tokens.inkOnAccent),

  riskHigh: hex(risk.high),
  riskMedium: hex(risk.medium),
  riskLow: hex(risk.low),
}

// Accent variants — the brand cyan plus alternates users can cycle through
// (leader t). Cycling recolors the accent family in place; the reactor +
// most panes repaint every ~100ms tick, so the new hue lands within a
// frame. The choice persists to ~/.config/jarvis/tui.json { "accent": ... }.
const ACCENT_THEMES: Record<string, { accent: string; bright: string; second: string }> = {
  cyan: { accent: tokens.accent, bright: tokens.accentBright, second: tokens.accent2 },
  amber: { accent: "#FFB454", bright: "#FFD79A", second: "#FF8C42" },
  violet: { accent: "#B28BFF", bright: "#D7C4FF", second: "#8A6BFF" },
  emerald: { accent: "#39E6A0", bright: "#7CF3C6", second: "#2BB9C9" },
}
const ACCENT_ORDER = ["cyan", "amber", "violet", "emerald"]
let currentAccent = "cyan"

/** Swap the RGBA channels of an existing theme color in place (keeps the
 * object identity components already captured, so new paints recolor). */
function recolor(target: RGBA, hexStr: string): void {
  const next = RGBA.fromHex(hexStr)
  target.r = next.r
  target.g = next.g
  target.b = next.b
  target.a = next.a
}

export function applyAccent(name: string): void {
  const spec = ACCENT_THEMES[name]
  if (!spec) return
  currentAccent = name
  recolor(theme.accent, spec.accent)
  recolor(theme.accentBright, spec.bright)
  recolor(theme.accent2, spec.second)
}

/** leader t — advance to the next accent, persist, return the new name. */
export function cycleTheme(): string {
  const next = ACCENT_ORDER[(ACCENT_ORDER.indexOf(currentAccent) + 1) % ACCENT_ORDER.length]
  applyAccent(next)
  try {
    const path = join(configDir(), "tui.json")
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    } catch {
      // no config yet
    }
    cfg.accent = next
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(path, JSON.stringify(cfg, null, 2))
  } catch {
    // read-only config dir — the in-memory swap still applied
  }
  return next
}

/** Restore the saved accent at boot. */
export function loadSavedAccent(): void {
  try {
    const cfg = JSON.parse(readFileSync(join(configDir(), "tui.json"), "utf8")) as {
      accent?: string
    }
    if (cfg.accent) applyAccent(cfg.accent)
  } catch {
    // default cyan
  }
}

export type Theme = typeof theme

// Markdown/code highlighting in the jarvis palette. Lazy: SyntaxStyle needs
// the native render lib, which only exists once a renderer is alive.
let cachedSyntax: SyntaxStyle | undefined
export function syntaxStyle(): SyntaxStyle {
  cachedSyntax ??= SyntaxStyle.fromStyles({
    default: { fg: tokens.text },
    keyword: { fg: tokens.accent, bold: true },
    string: { fg: tokens.success },
    number: { fg: tokens.amber },
    comment: { fg: tokens.textFaint, italic: true },
    function: { fg: tokens.accent2 },
    type: { fg: tokens.violet },
    variable: { fg: tokens.text },
    operator: { fg: tokens.textMuted },
    punctuation: { fg: tokens.textMuted },
    constant: { fg: tokens.amber },
    tag: { fg: tokens.magenta },
    attribute: { fg: tokens.violet },
    "markup.heading": { fg: tokens.accentBright, bold: true },
    "markup.bold": { fg: tokens.text, bold: true },
    "markup.italic": { fg: tokens.text, italic: true },
    "markup.link": { fg: tokens.accent2, underline: true },
    "markup.raw": { fg: tokens.amber },
    "markup.list": { fg: tokens.accent },
  })
  return cachedSyntax
}
