// Resolved theme — tokens.ts hex values lifted into @opentui RGBA once.

import { RGBA } from "@opentui/core"

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
