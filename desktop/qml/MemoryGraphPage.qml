pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// GRAPH page (jarvis#70 phase 1): a visual browser over the knowledge graph —
// entities (people/projects/topics) auto-extracted from memory text/tags, and
// the memories/entities they're linked to. Node-link canvas with a
// Fruchterman-Reingold force layout computed once per data load; click a node
// to inspect it, double-click to re-center the view on it.
Item {
    id: page

    property var graphNodes: []          // [{id,kind,...}]
    property var graphEdges: []          // [{from,to,relation}]
    property var nodePos: ({})           // id -> {x,y}, mutated in place by node-drag
    property bool layoutDirty: false
    property string rootId: ""           // "" == default overview
    property string selectedId: ""
    property var selectedNode: null
    property var selectedRelated: []     // populated for entity nodes via memory.entity.get

    // Pan (drag empty space) + per-node drag (drag a node to reposition it).
    // viewOffset is a pure draw-time translate; nodePos itself stays in
    // "graph space" so re-layout/hit-testing math doesn't need to know about it.
    property real viewOffsetX: 0
    property real viewOffsetY: 0
    property string dragNodeId: ""
    property bool didDrag: false
    property real pressX: 0
    property real pressY: 0
    property real panStartOffsetX: 0
    property real panStartOffsetY: 0
    property string hoveredId: ""

    function nodeById(id) {
        for (var i = 0; i < page.graphNodes.length; i++)
            if (page.graphNodes[i].id === id)
                return page.graphNodes[i]
        return null
    }

    function refresh() {
        bridge.memoryGraph(page.rootId, 2)
    }
    Component.onCompleted: if (bridge.connected) page.refresh()
    onVisibleChanged: if (visible && bridge.connected) page.refresh()

    function recenter(id) {
        page.rootId = id
        page.selectedId = ""
        page.selectedNode = null
        bridge.memoryGraph(id, 2)
    }
    function backToOverview() {
        page.rootId = ""
        page.selectedId = ""
        page.selectedNode = null
        bridge.memoryGraph("", 2)
    }

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onMemoryGraphLoaded(graph) {
            page.graphNodes = graph && graph.nodes ? graph.nodes : []
            page.graphEdges = graph && graph.edges ? graph.edges : []
            page.layoutDirty = true
            page.viewOffsetX = 0
            page.viewOffsetY = 0
            canvas.requestPaint()
            // A previously-selected node may have dropped out of the subgraph
            // (e.g. after re-centering) — clear stale selection detail.
            if (page.selectedId.length > 0 && !page.nodeById(page.selectedId)) {
                page.selectedId = ""
                page.selectedNode = null
            }
        }
        function onMemoryEntityLoaded(entity) {
            if (!entity || entity.id !== page.selectedId)
                return
            page.selectedRelated = entity.related !== undefined ? entity.related : []
        }
        function onMemoryChanged() { page.refresh() }
    }

    // --- force-directed layout (Fruchterman-Reingold, computed once per load) --
    function computeLayout(nodes, edges, w, h) {
        var pos = {}
        var n = nodes.length
        if (n === 0 || w <= 0 || h <= 0)
            return pos
        var rad = Math.min(w, h) * 0.35
        for (var i = 0; i < n; i++) {
            var a = (i / n) * Math.PI * 2
            pos[nodes[i].id] = { x: w / 2 + Math.cos(a) * rad, y: h / 2 + Math.sin(a) * rad }
        }
        var k = Math.sqrt((w * h) / Math.max(1, n))
        var iterations = Math.min(150, 60 + n * 2)
        var margin = 34
        for (var it = 0; it < iterations; it++) {
            var disp = {}
            for (i = 0; i < n; i++) disp[nodes[i].id] = { x: 0, y: 0 }
            for (i = 0; i < n; i++) {
                for (var j = i + 1; j < n; j++) {
                    var ida = nodes[i].id, idb = nodes[j].id
                    var dx = pos[ida].x - pos[idb].x, dy = pos[ida].y - pos[idb].y
                    var dist = Math.sqrt(dx * dx + dy * dy) || 0.01
                    var force = (k * k) / dist
                    var ux = dx / dist, uy = dy / dist
                    disp[ida].x += ux * force; disp[ida].y += uy * force
                    disp[idb].x -= ux * force; disp[idb].y -= uy * force
                }
            }
            for (var e = 0; e < edges.length; e++) {
                var fa = edges[e].from, fb = edges[e].to
                if (!pos[fa] || !pos[fb]) continue
                var edx = pos[fa].x - pos[fb].x, edy = pos[fa].y - pos[fb].y
                var edist = Math.sqrt(edx * edx + edy * edy) || 0.01
                var eforce = (edist * edist) / k
                var eux = edx / edist, euy = edy / edist
                disp[fa].x -= eux * eforce; disp[fa].y -= euy * eforce
                disp[fb].x += eux * eforce; disp[fb].y += euy * eforce
            }
            var temp = k * (1 - it / iterations)
            for (i = 0; i < n; i++) {
                var id = nodes[i].id
                var dlen = Math.sqrt(disp[id].x * disp[id].x + disp[id].y * disp[id].y) || 0.01
                var capped = Math.min(dlen, temp)
                pos[id].x += (disp[id].x / dlen) * capped
                pos[id].y += (disp[id].y / dlen) * capped
                pos[id].x += (w / 2 - pos[id].x) * 0.01
                pos[id].y += (h / 2 - pos[id].y) * 0.01
                pos[id].x = Math.max(margin, Math.min(w - margin, pos[id].x))
                pos[id].y = Math.max(margin, Math.min(h - margin, pos[id].y))
            }
        }
        return pos
    }

    function nodeColor(node) {
        if (node.kind === "entity")
            return node.scope === "project" ? Theme.amber : Theme.violet
        return Theme.accent
    }
    function nodeRadius(node) {
        return node.kind === "entity" ? 9 : 6
    }
    function nodeLabel(node) {
        var raw = node.kind === "entity" ? node.name : node.text
        raw = raw ? raw : ""
        return raw.length > 24 ? raw.substring(0, 23) + "…" : raw
    }
    function hitTest(mx, my) {
        var best = "", bestDist = 16 // px hit radius
        for (var i = 0; i < page.graphNodes.length; i++) {
            var n = page.graphNodes[i]
            var p = page.nodePos[n.id]
            if (!p) continue
            var d = Math.sqrt((p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my))
            if (d < bestDist) { bestDist = d; best = n.id }
        }
        return best
    }
    function selectNode(id) {
        page.selectedId = id
        page.selectedNode = page.nodeById(id)
        page.selectedRelated = []
        if (page.selectedNode && page.selectedNode.kind === "entity")
            bridge.memoryEntityGet(id)
        canvas.requestPaint()
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        PageHeader {
            Layout.fillWidth: true
            title: "Knowledge Graph"
            subtitle: "Entities and relationships auto-extracted from memory. Drag empty space to pan, drag a node to move it, click to inspect, double-click to re-center."
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            Text {
                Layout.fillWidth: true
                text: page.rootId.length > 0
                      ? "Rooted at: " + (page.selectedNode ? page.nodeLabel(page.selectedNode) : page.rootId)
                      : (page.graphNodes.length + " nodes · " + page.graphEdges.length + " links")
                color: Theme.textFaint
                font.family: Theme.fontMono
                font.pixelSize: 11
                elide: Text.ElideRight
            }
            Widgets.PillButton {
                label: "Overview"
                visible: page.rootId.length > 0
                onClicked: page.backToOverview()
            }
            Widgets.PillButton {
                label: "Refresh"
                onClicked: page.refresh()
            }
        }

        // ---- empty state -----------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: page.graphNodes.length === 0

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 12
                width: parent.width - 60

                ArcReactor {
                    Layout.alignment: Qt.AlignHCenter
                    size: 84
                    tint: Theme.violet
                }
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "GRAPH EMPTY"
                    color: Theme.accentBright
                    font.family: Theme.fontDisplay
                    font.pixelSize: 15
                    font.weight: Font.DemiBold
                    font.letterSpacing: Theme.trackMid
                }
                Text {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                    text: "As you save memories, Jarvis auto-extracts people, projects, and topics and links them here."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 13
                    lineHeight: 1.3
                }
            }
        }

        // ---- graph canvas -----------------------------------------------
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: page.graphNodes.length > 0
            radius: Theme.radius
            color: Theme.panelSoft
            border.color: Theme.hairlineSoft
            border.width: 1
            clip: true

            Canvas {
                id: canvas
                anchors.fill: parent
                anchors.margins: 1
                renderStrategy: Canvas.Cooperative

                onWidthChanged: { page.layoutDirty = true; requestPaint() }
                onHeightChanged: { page.layoutDirty = true; requestPaint() }

                onPaint: {
                    var ctx = getContext("2d")
                    ctx.reset()
                    if (page.layoutDirty && width > 0 && height > 0) {
                        page.nodePos = page.computeLayout(page.graphNodes, page.graphEdges, width, height)
                        page.layoutDirty = false
                    }
                    ctx.translate(page.viewOffsetX, page.viewOffsetY)
                    var pos = page.nodePos

                    // edges: a soft wide glow pass underneath, then a crisp
                    // line on top — reads as a real "constellation" web at a glance.
                    ctx.lineCap = "round"
                    for (var pass = 0; pass < 2; pass++) {
                        ctx.strokeStyle = pass === 0 ? Qt.rgba(0.239, 0.839, 1.0, 0.10) : Theme.hairline
                        ctx.lineWidth = pass === 0 ? 3.5 : 1
                        for (var e = 0; e < page.graphEdges.length; e++) {
                            var edge = page.graphEdges[e]
                            var pa = pos[edge.from], pb = pos[edge.to]
                            if (!pa || !pb) continue
                            ctx.beginPath()
                            ctx.moveTo(pa.x, pa.y)
                            ctx.lineTo(pb.x, pb.y)
                            ctx.stroke()
                        }
                    }

                    // nodes: a soft glow halo behind a crisp core dot.
                    for (var i = 0; i < page.graphNodes.length; i++) {
                        var node = page.graphNodes[i]
                        var p = pos[node.id]
                        if (!p) continue
                        var r = page.nodeRadius(node)
                        var isSelected = node.id === page.selectedId
                        var isHovered = node.id === page.hoveredId
                        var col = page.nodeColor(node)

                        ctx.beginPath()
                        ctx.arc(p.x, p.y, r + (isSelected || isHovered ? 8 : 5), 0, Math.PI * 2)
                        ctx.fillStyle = Qt.rgba(col.r, col.g, col.b, isSelected ? 0.28 : (isHovered ? 0.22 : 0.14))
                        ctx.fill()

                        ctx.beginPath()
                        ctx.arc(p.x, p.y, isSelected ? r + 2 : r, 0, Math.PI * 2)
                        ctx.fillStyle = Theme.surfaceStrong
                        ctx.fill()
                        ctx.lineWidth = isSelected ? 2.5 : (isHovered ? 2 : 1.5)
                        ctx.strokeStyle = col
                        ctx.stroke()

                        ctx.fillStyle = isSelected || isHovered ? Theme.text : Theme.textFaint
                        ctx.font = (isSelected ? "bold " : "") + "10px " + Theme.fontMono
                        ctx.textAlign = "center"
                        ctx.fillText(page.nodeLabel(node), p.x, p.y + r + 13)
                    }
                }

                MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    onPressed: function(mouse) {
                        page.didDrag = false
                        page.pressX = mouse.x
                        page.pressY = mouse.y
                        page.dragNodeId = page.hitTest(mouse.x - page.viewOffsetX, mouse.y - page.viewOffsetY)
                        page.panStartOffsetX = page.viewOffsetX
                        page.panStartOffsetY = page.viewOffsetY
                    }
                    onPositionChanged: function(mouse) {
                        if (mouse.buttons & Qt.LeftButton) {
                            var dx = mouse.x - page.pressX, dy = mouse.y - page.pressY
                            if (Math.abs(dx) > 3 || Math.abs(dy) > 3)
                                page.didDrag = true
                            if (page.dragNodeId.length > 0) {
                                var p = page.nodePos[page.dragNodeId]
                                if (p) {
                                    p.x = mouse.x - page.viewOffsetX
                                    p.y = mouse.y - page.viewOffsetY
                                    canvas.requestPaint()
                                }
                            } else if (page.didDrag) {
                                page.viewOffsetX = page.panStartOffsetX + dx
                                page.viewOffsetY = page.panStartOffsetY + dy
                                canvas.requestPaint()
                            }
                        } else {
                            var hit = page.hitTest(mouse.x - page.viewOffsetX, mouse.y - page.viewOffsetY)
                            if (hit !== page.hoveredId) {
                                page.hoveredId = hit
                                canvas.requestPaint()
                            }
                        }
                    }
                    onClicked: function(mouse) {
                        if (page.didDrag)
                            return
                        var hit = page.hitTest(mouse.x - page.viewOffsetX, mouse.y - page.viewOffsetY)
                        if (hit.length > 0)
                            page.selectNode(hit)
                        else {
                            page.selectedId = ""
                            page.selectedNode = null
                            canvas.requestPaint()
                        }
                    }
                    onDoubleClicked: function(mouse) {
                        var hit = page.hitTest(mouse.x - page.viewOffsetX, mouse.y - page.viewOffsetY)
                        if (hit.length > 0)
                            page.recenter(hit)
                    }
                }
            }
        }

        // ---- selected-node detail card -----------------------------------
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: detailContent.implicitHeight + 24
            visible: page.selectedNode !== null
            radius: Theme.radius
            color: Theme.panelSoft
            border.color: Theme.hairlineSoft
            border.width: 1

            ColumnLayout {
                id: detailContent
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 14
                spacing: 6

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text {
                        Layout.fillWidth: true
                        text: page.selectedNode ? page.nodeLabel(page.selectedNode) : ""
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        visible: page.selectedNode && page.selectedNode.kind === "entity"
                        text: page.selectedNode ? ("[" + page.selectedNode.type
                                                    + (page.selectedNode.scope === "project" ? " · project" : "") + "]") : ""
                        color: Theme.violet
                        font.family: Theme.fontMono
                        font.pixelSize: 10
                    }
                }
                Text {
                    Layout.fillWidth: true
                    visible: page.selectedRelated.length > 0
                    text: "Linked: " + page.selectedRelated.map(function(r) {
                              return r.kind === "entity" ? r.name : (r.text ? r.text.substring(0, 30) : "")
                          }).join(", ")
                    color: Theme.textFaint
                    font.family: Theme.fontMono
                    font.pixelSize: 10
                    wrapMode: Text.WordWrap
                }
                Widgets.PillButton {
                    label: "Re-center here"
                    visible: page.selectedNode !== null
                    onClicked: page.recenter(page.selectedId)
                }
            }
        }
    }
}
