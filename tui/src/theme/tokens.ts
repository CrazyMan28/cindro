// Design tokens — kept color-identical to desktop/qml/Theme.qml (the GUI's
// single styling source). If a hex changes there it changes here; the arc
// reactor MUST keep using the same two cyans on both frontends.

export const tokens = {
  // backgrounds
  bgTop: "#070A10",
  bgBottom: "#0A0F17",
  bgDeep: "#04070C",
  base: "#0A0E16",
  surface: "#111A25",
  surfaceStrong: "#15212F",
  surfaceDeep: "#0A0E16",

  // hairlines / borders
  hairline: "#26384A",
  hairlineSoft: "#1E2C3B",
  hairlineFaint: "#16202C",

  // brand energy
  accent: "#3DD6FF", // arc-reactor cyan
  accentBright: "#7FF4FF", // highlights / hot core
  accent2: "#5B8CFF", // cyan→blue gradient end
  accentDeep: "#1C6E86",

  amber: "#FFB454",
  violet: "#B28BFF",
  magenta: "#FF7AC6",
  success: "#39E6A0",
  danger: "#FF6B6B",

  // text
  text: "#EAF2F8",
  textMuted: "#90A6B8",
  textFaint: "#5C7185",
  inkOnAccent: "#062330",
} as const

export const risk = {
  high: tokens.danger,
  medium: tokens.amber,
  low: tokens.success,
} as const

// Motion periods (ms) — identical to ArcReactor.qml / arc_reactor.py so the
// terminal reactor spins in lockstep with the desktop one.
export const motion = {
  ringSlowMs: 14000,
  ringFastMs: 9000,
  ringInnerMs: 19600,
  pulseMs: 2200,
  orbitMs: 1400,
} as const
