// JS mirror of theme.css's tokens, ported 1:1 from desktop/qml/Theme.qml, for
// components that draw on <canvas>/SVG (ArcReactor, WidgetRenderer's "canvas"
// node, NavIcon glyphs) where CSS custom properties aren't directly usable.
// CSS is still the source of truth for anything DOM/styling — keep these in
// sync with theme.css if either changes.
export const theme = {
  bgTop: "#070A10",
  bgBottom: "#0A0F17",
  bgDeep: "#04070C",
  base: "#0A0E16",

  surface: "#111A25",
  surfaceStrong: "#15212F",
  surfaceDeep: "#0A0E16",

  hairline: "#26384A",
  hairlineSoft: "#1E2C3B",
  hairlineFaint: "#16202C",

  accent: "#3DD6FF",
  accentBright: "#7FF4FF",
  accent2: "#5B8CFF",
  accentDeep: "#1C6E86",
  accentDim: "rgba(61, 214, 255, 0.16)",
  accentFaint: "rgba(61, 214, 255, 0.085)",
  accentGlow: "rgba(61, 214, 255, 0.50)",

  amber: "#FFB454",
  amberDim: "rgba(255, 180, 84, 0.18)",
  violet: "#B28BFF",
  magenta: "#FF7AC6",
  pink: "#FF7AC6",
  success: "#39E6A0",
  danger: "#FF6B6B",
  dangerDim: "rgba(255, 107, 107, 0.16)",

  text: "#EAF2F8",
  textMuted: "#90A6B8",
  textFaint: "#5C7185",
  inkOnAccent: "#062330",

  fontDisplay: '"Orbitron", "Rajdhani", "Michroma", "Saira", "Eurostile", "Noto Sans", sans-serif',
  fontSans: '"Inter", "Noto Sans", sans-serif',
  fontMono: '"JetBrains Mono", "Noto Sans Mono", monospace',

  radius: 14,
  radiusSm: 10,
  radiusXs: 7,

  durFast: 110,
  durMid: 200,
  durSlow: 320,
  durPage: 260,
  ringSlow: 14000,
  ringFast: 9000,
  pulse: 2200,

  railWidth: 148,
  railFill: "#0A0E16",
  navActive: "rgba(61, 214, 255, 0.13)",
} as const

export type Theme = typeof theme
