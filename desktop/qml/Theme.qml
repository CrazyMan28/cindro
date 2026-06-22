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
    readonly property color bgTop:     "#05080E"   // deep near-black blue (top)
    readonly property color bgBottom:  "#0A121C"   // slightly lifted (bottom)
    readonly property color bgDeep:    "#04060B"   // darkest pockets / voids
    readonly property color base:      "#070C14"   // flat fill where needed

    // ---- Glassy panel surfaces (translucent over the gradient) -------------
    readonly property color panel:         Qt.rgba(0.039, 0.071, 0.110, 0.72)  // rgba(10,18,28,0.72)
    readonly property color panelSoft:     Qt.rgba(0.055, 0.090, 0.137, 0.55)
    readonly property color surface:       Qt.rgba(0.094, 0.157, 0.227, 0.40)
    readonly property color surfaceStrong: Qt.rgba(0.16, 0.27, 0.40, 0.30)
    readonly property color surfaceInput:  Qt.rgba(0.02, 0.05, 0.09, 0.55)
    readonly property color surfaceDeep:   Qt.rgba(0.0, 0.0, 0.0, 0.30)

    // ---- Hairlines / borders ------------------------------------------------
    readonly property color hairline:     Qt.rgba(0.161, 0.906, 1.0, 0.25)   // cyan-tinted 1px
    readonly property color hairlineSoft:  Qt.rgba(0.62, 0.78, 0.95, 0.10)
    readonly property color hairlineFaint: Qt.rgba(0.62, 0.78, 0.95, 0.055)

    // ---- ARC-REACTOR CYAN (primary) ----------------------------------------
    readonly property color accent:      "#29E7FF"
    readonly property color accentBright: "#7FF4FF"   // highlights / hot core
    readonly property color accentDim:    Qt.rgba(0.161, 0.906, 1.0, 0.18)
    readonly property color accentFaint:  Qt.rgba(0.161, 0.906, 1.0, 0.09)
    readonly property color accentGlow:   Qt.rgba(0.161, 0.906, 1.0, 0.55)

    // ---- Energy accents -----------------------------------------------------
    readonly property color amber:    "#FFB454"   // warnings / active energy
    readonly property color amberDim:  Qt.rgba(1.0, 0.706, 0.329, 0.18)
    readonly property color violet:   "#B14BFF"   // cyberpunk violet
    readonly property color magenta:  "#FF3D81"   // hot magenta (gradient edges)
    readonly property color success:  "#3DFF9E"
    readonly property color danger:   "#FF4D5E"
    readonly property color dangerDim: Qt.rgba(1.0, 0.30, 0.369, 0.16)

    // semantic aliases used by older call-sites
    readonly property color ok:    theme.success
    readonly property color warn:  theme.amber

    // ---- Type ---------------------------------------------------------------
    readonly property color text:      "#EAF6FF"
    readonly property color textMuted:  "#8DA6C4"
    readonly property color textFaint:  "#54688A"
    readonly property color inkOnAccent: "#03141B"   // text drawn ON a cyan fill

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
    readonly property color railFill:  Qt.rgba(0.02, 0.05, 0.09, 0.55)
    readonly property color navActive: Qt.rgba(0.161, 0.906, 1.0, 0.12)
}
