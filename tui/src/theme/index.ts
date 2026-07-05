// Resolved theme — tokens.ts hex values lifted into @opentui RGBA once.

import { RGBA, SyntaxStyle } from "@opentui/core"

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
} as const

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
