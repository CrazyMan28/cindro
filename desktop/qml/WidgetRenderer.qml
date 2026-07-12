pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import CindroSidebar

// WidgetRenderer — a SAFE, recursive interpreter for the render_widget JSON DSL.
//
// `node` is a plain object (QVariantMap/QVariantList from the file bus). We render
// it declaratively per type via a Loader that picks a sub-component; container
// nodes (column/row) recurse by instantiating WidgetRenderer for each child. The
// spec is DATA — nothing here is ever eval'd as QML/JS.
//
// Supported types: column, row, text, rect, badge, image, canvas, button,
// progress, list, grid, divider, link. Unknown types render nothing; missing
// fields fall back to sane Theme defaults.
Item {
    id: root
    property var node: undefined

    // A `button` node was clicked. `action` is the node's plain `action` map
    // (DATA, e.g. {"send":"…"} or {"skill":"…","args":"…"}); the host (CanvasPage
    // / StandaloneWidget) maps it to bridge.sendMessage / bridge.skillInvoke. The
    // signal bubbles up through nested WidgetRenderers (grid/column/row children
    // re-emit their child's actionRequested) so a single connection at the card
    // root catches actions from any depth. NOTHING here is ever eval'd.
    signal actionRequested(var action)

    // Resolve a color string, falling back to a default when absent/empty.
    function colorOr(v, fallback) {
        return (typeof v === "string" && v.length > 0) ? v : fallback
    }
    function numOr(v, fallback) {
        return (v !== undefined && v !== null && !isNaN(Number(v))) ? Number(v) : fallback
    }
    // Coerce a spec array into a REAL JS array. Nested children/ops/rows reach a
    // child node through a `var` property (Repeater modelData → C++ QVariant) as a
    // QVariantList — array-LIKE (numeric .length, indexable) but NOT a JS Array, so
    // Array.isArray() is false and a Repeater fed it directly renders nothing. This
    // copies any array-like into a true array (and tolerates real arrays), so nested
    // containers/grids/lists/canvas-ops render at every depth, not just top level.
    function asArray(x) {
        if (Array.isArray(x))
            return x
        if (x && typeof x === "object" && typeof x.length === "number") {
            var out = []
            for (var i = 0; i < x.length; i++)
                out.push(x[i])
            return out
        }
        return []
    }

    // Horizontal alignment flag from "left"/"center"/"right" (default left).
    function hAlign(a) {
        return a === "center" ? Qt.AlignHCenter
             : a === "right"  ? Qt.AlignRight
             : Qt.AlignLeft
    }
    // Map a child node's layout hints onto a Loader inside a Grid/Column/Row:
    //   grow:true -> fillWidth; align:left|center|right -> h-align;
    //   w/h -> preferred size (so the model can size ANY child, not just rect/svg).
    // Returns nothing; mutates the loader. Called from the recursing delegates.
    function applyLayoutHints(ld, m) {
        // grow:true fills the line; a divider spans full width by default.
        ld.Layout.fillWidth = (m && (m.grow === true || m.type === "divider"))
        ld.Layout.alignment = root.hAlign(m && typeof m.align === "string" ? m.align : "") | Qt.AlignTop
        if (m && m.w !== undefined && !isNaN(Number(m.w)))
            ld.Layout.preferredWidth = Number(m.w)
        if (m && m.h !== undefined && !isNaN(Number(m.h)))
            ld.Layout.preferredHeight = Number(m.h)
    }

    readonly property string nodeType:
        (node && typeof node === "object" && typeof node.type === "string") ? node.type : ""

    implicitWidth: loader.implicitWidth
    implicitHeight: loader.implicitHeight

    // ---- animation : the model can make any node move/breathe via node.anim ----
    // {anim:{type:"pulse"|"fade"|"spin"|"float"|"blink", duration:<ms>, loop:true}}.
    // Applied to THIS node's render transform (scale/opacity/rotation/translate) —
    // render-only, so it never disturbs layout. anim on a child animates just that
    // child; anim on the root animates the whole widget.
    readonly property var anim: (node && node.anim && typeof node.anim === "object") ? node.anim : null
    readonly property string animType: anim ? ("" + (anim.type || "")) : ""
    readonly property int animDur: anim ? numOr(anim.duration, 1200) : 1200
    transformOrigin: Item.Center
    transform: Translate { id: floatT }

    SequentialAnimation on scale {
        running: root.animType === "pulse"; loops: Animation.Infinite; alwaysRunToEnd: true
        NumberAnimation { from: 1.0; to: 1.12; duration: root.animDur / 2; easing.type: Easing.InOutSine }
        NumberAnimation { from: 1.12; to: 1.0; duration: root.animDur / 2; easing.type: Easing.InOutSine }
    }
    SequentialAnimation on opacity {
        running: root.animType === "fade" || root.animType === "blink"
        loops: Animation.Infinite; alwaysRunToEnd: true
        NumberAnimation { to: root.animType === "blink" ? 0.0 : 0.3; duration: root.animDur / 2
                          easing.type: root.animType === "blink" ? Easing.Linear : Easing.InOutSine }
        NumberAnimation { to: 1.0; duration: root.animDur / 2
                          easing.type: root.animType === "blink" ? Easing.Linear : Easing.InOutSine }
    }
    RotationAnimation on rotation {
        running: root.animType === "spin"; loops: Animation.Infinite
        from: 0; to: 360; duration: root.animDur
    }
    SequentialAnimation {
        running: root.animType === "float"; loops: Animation.Infinite; alwaysRunToEnd: true
        NumberAnimation { target: floatT; property: "y"; from: 0; to: -6; duration: root.animDur / 2; easing.type: Easing.InOutSine }
        NumberAnimation { target: floatT; property: "y"; from: -6; to: 0; duration: root.animDur / 2; easing.type: Easing.InOutSine }
    }

    Loader {
        id: loader
        // Pass the root's (layout-assigned) WIDTH down to the content so a node
        // STRETCHED by a parent (grow:true / the chat card's fillWidth) fills it —
        // without this, nested grid/grow cells collapsed to dots. HEIGHT stays
        // intrinsic (implicitHeight), NOT anchored to root.height: anchoring height
        // fed the grid's row-height assignment back into the cell and collapsed
        // container cells to empty bars. A node with an explicit w sizes to that.
        anchors.left: parent.left
        anchors.top: parent.top
        width: (root.node && root.node.w !== undefined) ? implicitWidth : root.width
        height: implicitHeight
        sourceComponent: {
            switch (root.nodeType) {
            case "column":
            case "row":     return containerComp
            case "pager":   return pagerComp
            case "text":    return textComp
            case "rect":    return rectComp
            case "badge":   return badgeComp
            case "image":   return imageComp
            case "svg":     return svgComp
            case "canvas":  return canvasComp
            case "button":  return buttonComp
            case "progress": return progressComp
            case "list":    return listComp
            case "grid":    return gridComp
            case "divider": return dividerComp
            case "spacer":  return spacerComp
            case "link":    return linkComp
            default:        return null   // unknown / malformed → render nothing
            }
        }
    }

    // ---- pager : a MULTI-PAGE widget (quizzes, wizards, slideshows) ---------
    // {type:"pager", pages:[<node>,…], page:0}. Shows ONE page at a time with an
    // animated slide/fade between them. Buttons inside drive navigation WITHOUT a
    // model round-trip: an action of {next:true}/{prev:true}/{goto:N} is consumed
    // by the pager; any OTHER action (send/skill) still bubbles up to the host.
    Component {
        id: pagerComp
        Item {
            id: pager
            readonly property var pages: root.asArray(root.node ? root.node.pages : null)
            readonly property int pageCount: pages ? pages.length : 0
            property int curPage: Math.max(0, Math.min(pageCount - 1,
                                  root.numOr(root.node ? root.node.page : undefined, 0)))
            implicitWidth: root.width
            implicitHeight: pageHolder.implicitHeight
            clip: true

            function navigate(a) {
                var np = curPage
                if (a.goto !== undefined) np = root.numOr(a.goto, curPage)
                else if (a.next === true) np = curPage + 1
                else if (a.prev === true) np = curPage - 1
                np = Math.max(0, Math.min(pageCount - 1, np))
                if (np !== curPage) curPage = np
            }

            Item {
                id: pageHolder
                width: pager.width
                implicitHeight: pageLoader.item ? pageLoader.item.implicitHeight : 0
                height: implicitHeight
                opacity: 1
                transform: Translate { id: pageSlide; x: 0 }

                Loader {
                    id: pageLoader
                    width: pageHolder.width
                    source: Qt.resolvedUrl("WidgetRenderer.qml")
                    onLoaded: if (item) item.node = pager.pages[pager.curPage]
                    Connections {
                        target: pageLoader.item
                        ignoreUnknownSignals: true
                        function onActionRequested(a) {
                            if (a && (a.next === true || a.prev === true || a.goto !== undefined))
                                pager.navigate(a)        // consume nav locally
                            else
                                root.actionRequested(a)  // bubble send/skill to host
                        }
                    }
                }

                // animate the new page in (slide + fade) whenever it changes
                Connections {
                    target: pager
                    function onCurPageChanged() {
                        if (pageLoader.item) pageLoader.item.node = pager.pages[pager.curPage]
                        pageAnim.restart()
                    }
                }
                ParallelAnimation {
                    id: pageAnim
                    NumberAnimation { target: pageHolder; property: "opacity"; from: 0.0; to: 1.0; duration: root.animDur }
                    NumberAnimation { target: pageSlide; property: "x"; from: 26; to: 0; duration: root.animDur; easing.type: Easing.OutCubic }
                }
            }

            // page dots
            Row {
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.bottom: parent.bottom
                spacing: 5
                visible: pager.pageCount > 1 && (root.node ? root.node.dots !== false : true)
                Repeater {
                    model: pager.pageCount
                    delegate: Rectangle {
                        required property int index
                        width: index === pager.curPage ? 14 : 6
                        height: 6; radius: 3
                        color: index === pager.curPage ? Theme.accent : Theme.hairline
                        Behavior on width { NumberAnimation { duration: 160 } }
                    }
                }
            }
        }
    }

    // ---- column / row : a STYLABLE container that recurses over children ----
    // The model controls size + look: bg (background color), radius, border
    // (+ borderW), pad (inner padding), w/h (explicit size), fill:true (take the
    // full available width). Children get per-child layout hints (grow/align/w/h)
    // via applyLayoutHints. Defaults keep the old plain look (transparent, no pad).
    Component {
        id: containerComp
        Rectangle {
            id: cont
            readonly property real pad: root.numOr(root.node ? root.node.pad : undefined, 0)
            color: root.colorOr(root.node ? root.node.bg : "", "transparent")
            radius: root.numOr(root.node ? root.node.radius : undefined, 0)
            border.width: (root.node && typeof root.node.border === "string" && root.node.border.length > 0)
                          ? root.numOr(root.node.borderW, 1) : 0
            border.color: root.colorOr(root.node ? root.node.border : "", Theme.hairline)

            // Intrinsic size = content + padding (or explicit w/h). The ACTUAL width
            // follows root.width: a stretched root (grow / top-level card) makes the
            // container fill; an unstretched root is content-sized. fill:true is no
            // longer needed (containers fill their slot by default) but is harmless.
            implicitWidth: (root.node && root.node.w !== undefined)
                           ? root.numOr(root.node.w, lay.implicitWidth + pad * 2)
                           : lay.implicitWidth + pad * 2
            implicitHeight: (root.node && root.node.h !== undefined)
                            ? root.numOr(root.node.h, lay.implicitHeight + pad * 2)
                            : lay.implicitHeight + pad * 2

            GridLayout {
                id: lay
                x: cont.pad; y: cont.pad
                width: Math.max(0, cont.width - cont.pad * 2)
                flow: root.nodeType === "row" ? GridLayout.LeftToRight : GridLayout.TopToBottom
                rows: root.nodeType === "row" ? 1 : -1
                columns: root.nodeType === "row" ? -1 : 1
                rowSpacing: root.numOr(root.node.gap, 6)
                columnSpacing: root.numOr(root.node.gap, 6)
                Repeater {
                    model: root.asArray(root.node ? root.node.children : null)
                    // Recurse via a URL-sourced Loader rather than naming
                    // WidgetRenderer directly: a component cannot eagerly
                    // instantiate its own type inside a delegate (the QML
                    // compiler rejects it as "instantiated recursively"),
                    // so we defer the self-reference to runtime by URL.
                    delegate: Loader {
                        required property var modelData
                        source: Qt.resolvedUrl("WidgetRenderer.qml")
                        onLoaded: { item.node = modelData; root.applyLayoutHints(this, modelData) }
                        // Bubble child actions up to the card root.
                        Connections {
                            target: loaderItemContainer.item
                            ignoreUnknownSignals: true
                            function onActionRequested(a) { root.actionRequested(a) }
                        }
                        id: loaderItemContainer
                    }
                }
            }
        }
    }

    // ---- text --------------------------------------------------------------
    // Rich: color, size, bold/italic, weight (100..900), spacing (letter), line
    // (lineHeight x), align (left/center/right), mono/display font, maxLines (clamp
    // + elide). The model styles type however it wants.
    Component {
        id: textComp
        Text {
            text: (root.node && root.node.text !== undefined) ? ("" + root.node.text) : ""
            color: root.colorOr(root.node ? root.node.color : "", Theme.text)
            font.family: (root.node && root.node.mono === true) ? Theme.fontMono
                         : (root.node && root.node.display === true) ? Theme.fontDisplay
                         : Theme.fontSans
            font.pixelSize: root.numOr(root.node ? root.node.size : undefined, 14)
            font.bold: root.node ? root.node.bold === true : false
            font.italic: root.node ? root.node.italic === true : false
            // strike: a line THROUGH the text (used for done plan/TODO items).
            font.strikeout: root.node ? root.node.strike === true : false
            font.weight: (root.node && root.node.weight !== undefined && !isNaN(Number(root.node.weight)))
                         ? Number(root.node.weight)
                         : (root.node && root.node.bold === true ? Font.DemiBold : Font.Normal)
            font.letterSpacing: root.numOr(root.node ? root.node.spacing : undefined, 0)
            lineHeight: root.numOr(root.node ? root.node.line : undefined, 1.0)
            lineHeightMode: Text.ProportionalHeight
            horizontalAlignment: root.hAlign(root.node && typeof root.node.align === "string"
                                             ? root.node.align : "")
            wrapMode: Text.WordWrap
            maximumLineCount: root.numOr(root.node ? root.node.maxLines : undefined, 100000)
            elide: (root.node && root.node.maxLines !== undefined) ? Text.ElideRight : Text.ElideNone
        }
    }

    // ---- rect --------------------------------------------------------------
    Component {
        id: rectComp
        Rectangle {
            implicitWidth: root.numOr(root.node ? root.node.w : undefined, 40)
            implicitHeight: root.numOr(root.node ? root.node.h : undefined, 40)
            // Stay intrinsic (don't stretch to a filled root).
            width: implicitWidth; height: implicitHeight
            radius: root.numOr(root.node ? root.node.radius : undefined, 0)
            color: root.colorOr(root.node ? root.node.color : "", Theme.accent)
        }
    }

    // ---- badge -------------------------------------------------------------
    Component {
        id: badgeComp
        Rectangle {
            implicitWidth: badgeText.implicitWidth + 18
            implicitHeight: badgeText.implicitHeight + 8
            // Stay a pill (don't stretch to a filled root).
            width: implicitWidth; height: implicitHeight
            radius: height / 2
            color: root.colorOr(root.node ? root.node.color : "", Theme.accentDim)
            border.width: 1
            border.color: Theme.hairline
            Text {
                id: badgeText
                anchors.centerIn: parent
                text: (root.node && root.node.text !== undefined) ? ("" + root.node.text) : ""
                color: Theme.text
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackTight
            }
        }
    }

    // ---- image (http/https or data: URI) -----------------------------------
    Component {
        id: imageComp
        Image {
            readonly property string rawUrl: (root.node && typeof root.node.url === "string")
                                              ? root.node.url : ""
            // SCHEME GUARD (mirrors linkComp's safe-scheme pattern): only ever
            // load data:image/, http:// or https:// — never file:/qrc:/other
            // schemes, which would let a widget read local files or probe
            // internal resources instead of just rendering a network image.
            readonly property bool safe: rawUrl.indexOf("data:image/") === 0 ||
                                          rawUrl.indexOf("http://") === 0 ||
                                          rawUrl.indexOf("https://") === 0
            // implicitWidth/implicitHeight on Image are read-only (derived from
            // sourceSize), so size the box explicitly from the spec's w/h, falling
            // back to a 120px square. PreserveAspectFit letterboxes within it.
            source: safe ? rawUrl : ""
            width: root.numOr(root.node ? root.node.w : undefined, 120)
            height: root.numOr(root.node ? root.node.h : undefined, 120)
            fillMode: Image.PreserveAspectFit
            asynchronous: true
            // Network images only; never run local programs / file probing here.
            cache: true
        }
    }

    // ---- svg : the model draws REAL vector art (a duck, chart, diagram…) ----
    // Renders raw <svg> markup via Qt's SVG image plugin. Data URI (base64) so any
    // markup survives intact. This is the "real renderer" — the model writes actual
    // SVG instead of a toy label.
    Component {
        id: svgComp
        Image {
            readonly property string svg: (root.node && typeof root.node.svg === "string")
                                          ? root.node.svg : ""
            width: root.numOr(root.node ? root.node.w : undefined, 260)
            height: root.numOr(root.node ? root.node.h : undefined, 260)
            sourceSize.width: width
            sourceSize.height: height
            fillMode: Image.PreserveAspectFit
            smooth: true
            source: svg.length > 0
                    ? ("data:image/svg+xml;base64," + Qt.btoa(svg))
                    : ""
        }
    }

    // ---- canvas : declarative draw ops -------------------------------------
    Component {
        id: canvasComp
        Canvas {
            id: cv
            implicitWidth: root.numOr(root.node ? root.node.w : undefined, 120)
            implicitHeight: root.numOr(root.node ? root.node.h : undefined, 120)
            width: implicitWidth
            height: implicitHeight
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                var ops = root.asArray(root.node ? root.node.ops : null)
                for (var i = 0; i < ops.length; i++) {
                    var o = ops[i]
                    if (!o || typeof o !== "object") continue
                    var fill = root.colorOr(o.fill, "")
                    var stroke = root.colorOr(o.stroke, "")
                    ctx.beginPath()
                    switch (o.op) {
                    case "circle":
                        ctx.arc(root.numOr(o.x, 0), root.numOr(o.y, 0),
                                Math.max(0, root.numOr(o.r, 0)), 0, Math.PI * 2)
                        break
                    case "ellipse":
                        ctx.save()
                        ctx.translate(root.numOr(o.x, 0), root.numOr(o.y, 0))
                        ctx.scale(Math.max(0.0001, root.numOr(o.rx, 1)),
                                  Math.max(0.0001, root.numOr(o.ry, 1)))
                        ctx.arc(0, 0, 1, 0, Math.PI * 2)
                        ctx.restore()
                        break
                    case "rect":
                        var rr = root.numOr(o.radius, 0)
                        var rx = root.numOr(o.x, 0), ry = root.numOr(o.y, 0)
                        var rw = root.numOr(o.w, 0), rh = root.numOr(o.h, 0)
                        if (rr > 0) {
                            rr = Math.min(rr, rw / 2, rh / 2)
                            ctx.moveTo(rx + rr, ry)
                            ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr)
                            ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr)
                            ctx.arcTo(rx, ry + rh, rx, ry, rr)
                            ctx.arcTo(rx, ry, rx + rw, ry, rr)
                            ctx.closePath()
                        } else {
                            ctx.rect(rx, ry, rw, rh)
                        }
                        break
                    case "path":
                        var pts = root.asArray(o.points)
                        for (var p = 0; p < pts.length; p++) {
                            var pt = root.asArray(pts[p])
                            if (pt.length < 2) continue
                            if (p === 0) ctx.moveTo(root.numOr(pt[0], 0), root.numOr(pt[1], 0))
                            else ctx.lineTo(root.numOr(pt[0], 0), root.numOr(pt[1], 0))
                        }
                        if (o.close === true) ctx.closePath()
                        break
                    case "line":
                        ctx.moveTo(root.numOr(o.x1, 0), root.numOr(o.y1, 0))
                        ctx.lineTo(root.numOr(o.x2, 0), root.numOr(o.y2, 0))
                        break
                    default:
                        continue
                    }
                    if (fill.length > 0) { ctx.fillStyle = fill; ctx.fill() }
                    if (stroke.length > 0 || o.op === "line") {
                        ctx.strokeStyle = stroke.length > 0 ? stroke : Theme.accent
                        ctx.lineWidth = Math.max(0.5, root.numOr(o.width, 1.5))
                        ctx.lineCap = "round"; ctx.lineJoin = "round"
                        ctx.stroke()
                    }
                }
            }
            // Re-draw if the spec swaps under us.
            Connections {
                target: root
                function onNodeChanged() { cv.requestPaint() }
            }
        }
    }

    // ---- button : interpreted action (send / skill), never eval'd ----------
    // Stylable: color (fill), textColor, radius, size (font px), w/h. The action
    // map (send/skill) is still allow-listed DATA — nothing is evaluated here.
    Component {
        id: buttonComp
        Rectangle {
            id: btn
            // feedback state for quiz answers: "" | "correct" | "wrong"
            property string feedback: ""
            readonly property color baseColor: root.colorOr(root.node ? root.node.color : "", Theme.accent)
            implicitWidth: Math.max(btnText.implicitWidth + 28,
                                    root.numOr(root.node ? root.node.w : undefined, 0))
            implicitHeight: Math.max(btnText.implicitHeight + 16,
                                     root.numOr(root.node ? root.node.h : undefined, 0))
            radius: root.numOr(root.node ? root.node.radius : undefined, Theme.radiusSm)
            color: btn.feedback === "correct" ? Theme.success
                   : btn.feedback === "wrong" ? Theme.danger
                   : btnArea.pressed ? Qt.darker(btn.baseColor, 1.2) : btn.baseColor
            Behavior on color { ColorAnimation { duration: 140 } }
            border.width: 1
            border.color: Theme.hairline
            opacity: btnArea.containsMouse ? 1.0 : 0.92
            scale: btnArea.pressed ? 0.96 : 1.0
            Behavior on scale { NumberAnimation { duration: 90 } }
            Text {
                id: btnText
                anchors.centerIn: parent
                text: btn.feedback === "correct" ? "✓ " + (root.node && root.node.text !== undefined ? ("" + root.node.text) : "")
                      : btn.feedback === "wrong" ? "✗ " + (root.node && root.node.text !== undefined ? ("" + root.node.text) : "")
                      : (root.node && root.node.text !== undefined) ? ("" + root.node.text) : "Button"
                color: (btn.feedback !== "") ? "#06140C"
                       : root.colorOr(root.node ? root.node.textColor : "", Theme.inkOnAccent)
                font.family: Theme.fontDisplay
                font.pixelSize: root.numOr(root.node ? root.node.size : undefined, 12)
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackTight
            }
            // after a correct/wrong flash, run any navigation in the action
            Timer {
                id: navTimer
                interval: 520
                property var pendingAction: null
                onTriggered: { if (pendingAction) root.actionRequested(pendingAction); pendingAction = null }
            }
            MouseArea {
                id: btnArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    var act = (root.node && root.node.action && typeof root.node.action === "object")
                              ? root.node.action : null
                    if (!act) return
                    // Quiz feedback: action.correct = true/false flashes the answer
                    // green/red, THEN (after a beat) runs any next/goto navigation.
                    if (act.correct !== undefined) {
                        btn.feedback = (act.correct === true) ? "correct" : "wrong"
                        if (act.next === true || act.prev === true || act.goto !== undefined) {
                            navTimer.pendingAction = act
                            navTimer.restart()
                        } else {
                            root.actionRequested(act)   // e.g. {correct, send:"…"}
                        }
                    } else {
                        root.actionRequested(act)       // nav or send/skill, immediate
                    }
                }
            }
        }
    }

    // ---- progress : determinate bar (value 0..1 or 0..100) -----------------
    Component {
        id: progressComp
        Item {
            implicitWidth: root.numOr(root.node ? root.node.w : undefined, 180)
            implicitHeight: 8
            Rectangle {
                id: track
                anchors.fill: parent
                radius: height / 2
                color: root.colorOr(root.node ? root.node.track : "", Theme.surface)
                border.width: 1
                border.color: Theme.hairlineSoft
            }
            Rectangle {
                height: parent.height
                radius: height / 2
                color: root.colorOr(root.node ? root.node.color : "", Theme.accent)
                // Normalize value: accept 0..1 OR 0..100, clamp to [0,1].
                width: parent.width * Math.max(0, Math.min(1, (function() {
                    var v = root.numOr(root.node ? root.node.value : undefined, 0)
                    return v > 1 ? v / 100 : v
                })()))
            }
        }
    }

    // ---- list : rows of {text, sub?, badge?, color?} -----------------------
    Component {
        id: listComp
        ColumnLayout {
            spacing: root.numOr(root.node ? root.node.gap : undefined, 6)
            Repeater {
                model: root.asArray(root.node ? root.node.rows : null)
                delegate: RowLayout {
                    id: rowItem
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 8
                    Rectangle {
                        width: 3; Layout.preferredHeight: rowCol.implicitHeight
                        radius: 1.5
                        color: root.colorOr(rowItem.modelData ? rowItem.modelData.color : "", Theme.accent)
                        opacity: 0.7
                    }
                    ColumnLayout {
                        id: rowCol
                        spacing: 1
                        Layout.fillWidth: true
                        Text {
                            text: (rowItem.modelData && rowItem.modelData.text !== undefined)
                                  ? ("" + rowItem.modelData.text) : ""
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 13
                            wrapMode: Text.WordWrap
                            Layout.fillWidth: true
                        }
                        Text {
                            visible: rowItem.modelData && rowItem.modelData.sub !== undefined
                                     && ("" + rowItem.modelData.sub).length > 0
                            text: (rowItem.modelData && rowItem.modelData.sub !== undefined)
                                  ? ("" + rowItem.modelData.sub) : ""
                            color: Theme.textMuted
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                            wrapMode: Text.WordWrap
                            Layout.fillWidth: true
                        }
                    }
                    Rectangle {
                        visible: rowItem.modelData && rowItem.modelData.badge !== undefined
                                 && ("" + rowItem.modelData.badge).length > 0
                        implicitWidth: badgeLbl.implicitWidth + 14
                        implicitHeight: badgeLbl.implicitHeight + 6
                        radius: height / 2
                        color: Theme.accentDim
                        border.width: 1
                        border.color: Theme.hairline
                        Layout.alignment: Qt.AlignVCenter
                        Text {
                            id: badgeLbl
                            anchors.centerIn: parent
                            text: (rowItem.modelData && rowItem.modelData.badge !== undefined)
                                  ? ("" + rowItem.modelData.badge) : ""
                            color: Theme.text
                            font.family: Theme.fontDisplay
                            font.pixelSize: 10
                            font.letterSpacing: Theme.trackTight
                        }
                    }
                }
            }
        }
    }

    // ---- grid : N-column grid of child nodes (recurses WidgetRenderer) ------
    // Same stylable shell as column/row (bg/radius/border/pad/w/h/fill) plus cols.
    Component {
        id: gridComp
        Rectangle {
            id: gcont
            readonly property real pad: root.numOr(root.node ? root.node.pad : undefined, 0)
            color: root.colorOr(root.node ? root.node.bg : "", "transparent")
            radius: root.numOr(root.node ? root.node.radius : undefined, 0)
            border.width: (root.node && typeof root.node.border === "string" && root.node.border.length > 0)
                          ? root.numOr(root.node.borderW, 1) : 0
            border.color: root.colorOr(root.node ? root.node.border : "", Theme.hairline)
            implicitWidth: (root.node && root.node.w !== undefined)
                           ? root.numOr(root.node.w, glay.implicitWidth + pad * 2)
                           : glay.implicitWidth + pad * 2
            implicitHeight: (root.node && root.node.h !== undefined)
                            ? root.numOr(root.node.h, glay.implicitHeight + pad * 2)
                            : glay.implicitHeight + pad * 2
            GridLayout {
                id: glay
                x: gcont.pad; y: gcont.pad
                width: Math.max(0, gcont.width - gcont.pad * 2)
                columns: Math.max(1, root.numOr(root.node ? root.node.cols : undefined, 2))
                rowSpacing: root.numOr(root.node ? root.node.gap : undefined, 8)
                columnSpacing: root.numOr(root.node ? root.node.gap : undefined, 8)
                Repeater {
                    model: root.asArray(root.node ? root.node.children : null)
                    // Recurse via a URL-sourced Loader (see container note above):
                    // self-naming the type in a delegate is rejected at compile
                    // time, so defer the recursion to runtime by URL.
                    delegate: Loader {
                        required property var modelData
                        source: Qt.resolvedUrl("WidgetRenderer.qml")
                        onLoaded: { item.node = modelData; root.applyLayoutHints(this, modelData) }
                        Connections {
                            target: gridLoaderItem.item
                            ignoreUnknownSignals: true
                            function onActionRequested(a) { root.actionRequested(a) }
                        }
                        id: gridLoaderItem
                    }
                }
            }
        }
    }

    // ---- divider : a hairline rule -----------------------------------------
    Component {
        id: dividerComp
        Rectangle {
            readonly property bool vertical: root.node ? root.node.vertical === true : false
            implicitWidth: vertical ? 1 : 120
            implicitHeight: vertical ? 24 : 1
            Layout.fillWidth: !vertical
            Layout.fillHeight: vertical
            color: root.colorOr(root.node ? root.node.color : "", Theme.hairline)
        }
    }

    // ---- spacer : empty gap. Fixed via size/w/h, or flexible with grow:true
    // (the layout hint sets fillWidth) to push siblings apart in a row/column.
    Component {
        id: spacerComp
        Item {
            implicitWidth: root.numOr(root.node ? root.node.w : undefined,
                                      root.numOr(root.node ? root.node.size : undefined, 8))
            implicitHeight: root.numOr(root.node ? root.node.h : undefined,
                                       root.numOr(root.node ? root.node.size : undefined, 8))
        }
    }

    // ---- link : opens http(s) url externally (scheme-guarded) --------------
    Component {
        id: linkComp
        Text {
            readonly property string url: (root.node && typeof root.node.url === "string")
                                          ? root.node.url : ""
            readonly property bool safe: url.indexOf("http://") === 0 || url.indexOf("https://") === 0
            text: (root.node && root.node.text !== undefined && ("" + root.node.text).length > 0)
                  ? ("" + root.node.text) : url
            color: root.colorOr(root.node ? root.node.color : "", Theme.accentBright)
            font.family: Theme.fontSans
            font.pixelSize: 13
            font.underline: true
            wrapMode: Text.WordWrap
            MouseArea {
                anchors.fill: parent
                cursorShape: parent.safe ? Qt.PointingHandCursor : Qt.ArrowCursor
                enabled: parent.safe
                // SCHEME GUARD: only ever open http(s); anything else is ignored.
                onClicked: if (parent.safe) Qt.openUrlExternally(parent.url)
            }
        }
    }
}
