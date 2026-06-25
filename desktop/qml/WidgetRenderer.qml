pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import JarvisSidebar

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

    readonly property string nodeType:
        (node && typeof node === "object" && typeof node.type === "string") ? node.type : ""

    implicitWidth: loader.implicitWidth
    implicitHeight: loader.implicitHeight

    Loader {
        id: loader
        sourceComponent: {
            switch (root.nodeType) {
            case "column":
            case "row":     return containerComp
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
            case "link":    return linkComp
            default:        return null   // unknown / malformed → render nothing
            }
        }
    }

    // ---- column / row : recurse over children ------------------------------
    Component {
        id: containerComp
        Item {
            implicitWidth: lay.implicitWidth
            implicitHeight: lay.implicitHeight
            GridLayout {
                id: lay
                flow: root.nodeType === "row" ? GridLayout.LeftToRight : GridLayout.TopToBottom
                rows: root.nodeType === "row" ? 1 : -1
                columns: root.nodeType === "row" ? -1 : 1
                rowSpacing: root.numOr(root.node.gap, 6)
                columnSpacing: root.numOr(root.node.gap, 6)
                Repeater {
                    model: Array.isArray(root.node.children) ? root.node.children : []
                    // Recurse via a URL-sourced Loader rather than naming
                    // WidgetRenderer directly: a component cannot eagerly
                    // instantiate its own type inside a delegate (the QML
                    // compiler rejects it as "instantiated recursively"),
                    // so we defer the self-reference to runtime by URL.
                    delegate: Loader {
                        required property var modelData
                        source: Qt.resolvedUrl("WidgetRenderer.qml")
                        Layout.alignment: Qt.AlignTop | Qt.AlignLeft
                        onLoaded: item.node = modelData
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
    Component {
        id: textComp
        Text {
            text: (root.node && root.node.text !== undefined) ? ("" + root.node.text) : ""
            color: root.colorOr(root.node ? root.node.color : "", Theme.text)
            font.family: Theme.fontSans
            font.pixelSize: root.numOr(root.node ? root.node.size : undefined, 14)
            font.bold: root.node ? root.node.bold === true : false
            font.italic: root.node ? root.node.italic === true : false
            wrapMode: Text.WordWrap
        }
    }

    // ---- rect --------------------------------------------------------------
    Component {
        id: rectComp
        Rectangle {
            implicitWidth: root.numOr(root.node ? root.node.w : undefined, 40)
            implicitHeight: root.numOr(root.node ? root.node.h : undefined, 40)
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
            // implicitWidth/implicitHeight on Image are read-only (derived from
            // sourceSize), so size the box explicitly from the spec's w/h, falling
            // back to a 120px square. PreserveAspectFit letterboxes within it.
            source: (root.node && typeof root.node.url === "string") ? root.node.url : ""
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
                var ops = (root.node && Array.isArray(root.node.ops)) ? root.node.ops : []
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
                        var pts = Array.isArray(o.points) ? o.points : []
                        for (var p = 0; p < pts.length; p++) {
                            var pt = pts[p]
                            if (!Array.isArray(pt) || pt.length < 2) continue
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
    Component {
        id: buttonComp
        Rectangle {
            id: btn
            implicitWidth: btnText.implicitWidth + 28
            implicitHeight: btnText.implicitHeight + 16
            radius: Theme.radiusSm
            color: btnArea.pressed
                   ? Qt.darker(root.colorOr(root.node ? root.node.color : "", Theme.accent), 1.2)
                   : root.colorOr(root.node ? root.node.color : "", Theme.accent)
            border.width: 1
            border.color: Theme.hairline
            opacity: btnArea.containsMouse ? 1.0 : 0.92
            Text {
                id: btnText
                anchors.centerIn: parent
                text: (root.node && root.node.text !== undefined) ? ("" + root.node.text) : "Button"
                color: Theme.inkOnAccent
                font.family: Theme.fontDisplay
                font.pixelSize: 12
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackTight
            }
            MouseArea {
                id: btnArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    // Emit the node's `action` map as DATA; the host allow-lists
                    // its keys (send / skill). Nothing is evaluated here.
                    var act = (root.node && root.node.action && typeof root.node.action === "object")
                              ? root.node.action : null
                    if (act)
                        root.actionRequested(act)
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
                model: (root.node && Array.isArray(root.node.rows)) ? root.node.rows : []
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
    Component {
        id: gridComp
        Item {
            implicitWidth: glay.implicitWidth
            implicitHeight: glay.implicitHeight
            GridLayout {
                id: glay
                columns: Math.max(1, root.numOr(root.node ? root.node.cols : undefined, 2))
                rowSpacing: root.numOr(root.node ? root.node.gap : undefined, 8)
                columnSpacing: root.numOr(root.node ? root.node.gap : undefined, 8)
                Repeater {
                    model: (root.node && Array.isArray(root.node.children)) ? root.node.children : []
                    // Recurse via a URL-sourced Loader (see container note above):
                    // self-naming the type in a delegate is rejected at compile
                    // time, so defer the recursion to runtime by URL.
                    delegate: Loader {
                        required property var modelData
                        source: Qt.resolvedUrl("WidgetRenderer.qml")
                        Layout.alignment: Qt.AlignTop | Qt.AlignLeft
                        onLoaded: item.node = modelData
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
