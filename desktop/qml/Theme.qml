pragma Singleton
import QtQuick

// ============================================================================
//  JARVIS HUD THEME  —  IRON-MAN x CYBERPUNK
//  Deep near-black-blue base, arc-reactor cyan primary, amber/violet/magenta
//  energy accents, neon glows, wide techy HUD typography. Every token used by
//  the restyled shell lives here so the whole app stays coherent.
// ============================================================================
QtObject {
    id: theme

    // ---- Base / background wash --------------------------------------------
    //  Aligned to the approved desktop redesign mockup (jarvis-desktop-redesign):
    //  bluer near-black base, solid lighter blue-grey cards, neutral hairlines,
    //  softer arc-reactor cyan — a cleaner, more premium read than the old
    //  heavily-translucent + cyan-tinted scheme.
    readonly property color bgTop:     "#070A10"   // app bg (top)
    readonly property color bgBottom:  "#0A0F17"   // app bg2 (bottom)
    readonly property color bgDeep:    "#04070C"   // darkest pockets / voids
    readonly property color base:      "#0A0E16"   // flat fill / rail

    // ---- Panel surfaces (solid cards, like the mockup) ---------------------
    //  surface/surfaceStrong are SOLID (#111A25 / #15212F) so cards read crisp
    //  and lighter; panel keeps a hair of translucency so the main HUD frame
    //  still floats over the gradient.
    readonly property color panel:         Qt.rgba(0.0667, 0.1020, 0.1451, 0.88) // #111A25 ~solid
    readonly property color panelSoft:     Qt.rgba(0.0824, 0.1294, 0.1843, 0.55)
    readonly property color surface:       "#111A25"
    readonly property color surfaceStrong: "#15212F"
    readonly property color surfaceInput:  Qt.rgba(0.0275, 0.0392, 0.0627, 0.65)
    readonly property color surfaceDeep:   "#0A0E16"

    // ---- Hairlines / borders (NEUTRAL blue-grey, like the mockup) ----------
    readonly property color hairline:     "#26384A"   // --line2 (visible 1px)
    readonly property color hairlineSoft:  "#1E2C3B"  // --line (default border)
    readonly property color hairlineFaint: "#16202C"

    // ---- ARC-REACTOR CYAN (primary) ----------------------------------------
    readonly property color accent:      "#3DD6FF"    // softer premium cyan (mockup)
    readonly property color accentBright: "#7FF4FF"   // highlights / hot core
    readonly property color accent2:     "#5B8CFF"    // blue gradient end (cyan→blue)
    readonly property color accentDeep:  "#1C6E86"    // dark cyan (bar/gradient bottoms)
    readonly property color accentDim:    Qt.rgba(0.239, 0.839, 1.0, 0.16)
    readonly property color accentFaint:  Qt.rgba(0.239, 0.839, 1.0, 0.085)
    readonly property color accentGlow:   Qt.rgba(0.239, 0.839, 1.0, 0.50)

    // ---- Energy accents -----------------------------------------------------
    readonly property color amber:    "#FFB454"   // warnings / active energy
    readonly property color amberDim:  Qt.rgba(1.0, 0.706, 0.329, 0.18)
    readonly property color violet:   "#B28BFF"   // softer violet (mockup)
    readonly property color magenta:  "#FF7AC6"   // pink (gradient edges)
    readonly property color pink:     "#FF7AC6"
    readonly property color success:  "#39E6A0"
    readonly property color danger:   "#FF6B6B"
    readonly property color dangerDim: Qt.rgba(1.0, 0.42, 0.42, 0.16)

    // semantic aliases used by older call-sites
    readonly property color ok:    theme.success
    readonly property color warn:  theme.amber

    // ---- Type ---------------------------------------------------------------
    readonly property color text:      "#EAF2F8"
    readonly property color textMuted:  "#90A6B8"
    readonly property color textFaint:  "#5C7185"
    readonly property color inkOnAccent: "#062330"   // text drawn ON a cyan fill

    // HUD display: wide geometric techy candidates -> bold condensed sans fallback.
    // Qt walks the comma list and falls back to the app default if none resolve.
    readonly property string fontDisplay: "Orbitron, Rajdhani, Michroma, Saira, Eurostile, Noto Sans"
    readonly property string fontSans:    "Inter, Noto Sans"
    readonly property string fontMono:    "JetBrains Mono, Noto Sans Mono, monospace"
    // tracking presets for HUD labels
    readonly property real trackWide:   2.0
    readonly property real trackMid:    1.2
    readonly property real trackTight:  0.4

    // ---- Geometry -----------------------------------------------------------
    readonly property int radius:    14
    readonly property int radiusSm:  10
    readonly property int radiusXs:  7

    readonly property int padPage:   16
    readonly property int gapLg:     16
    readonly property int gapMd:     12
    readonly property int gapSm:     8

    // ---- Glow params (MultiEffect) -----------------------------------------
    readonly property real glowSoft:   0.55
    readonly property real glowMid:    0.85
    readonly property real glowStrong: 1.25
    readonly property real bloomThreshold: 0.18

    // ---- Motion -------------------------------------------------------------
    readonly property int durFast:   110
    readonly property int durMid:    200
    readonly property int durSlow:   320
    readonly property int durPage:   260
    readonly property int ringSlow:  14000   // outer reactor ring period (ms)
    readonly property int ringFast:  9000    // inner reactor ring period (ms)
    readonly property int pulse:     2200    // core pulse period

    // ---- Nav rail -----------------------------------------------------------
    readonly property int railWidth:  148
    readonly property color railFill:  "#0A0E16"
    readonly property color navActive: Qt.rgba(0.239, 0.839, 1.0, 0.13)
}
