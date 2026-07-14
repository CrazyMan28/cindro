import SwiftUI

/// Canvas: a gallery of model-rendered widgets/canvases forwarded over the socket
/// (`widget.render` / `widget.remove` / `widget.clear`). Port of Android
/// `ui/canvas/CanvasScreen.kt`. Reads the app-lifetime [WidgetStore] so renders that
/// arrived while you were elsewhere survive navigating back here.
///
/// NOTE (parity gap): Android's `WidgetRenderer` is a full recursive interpreter for the
/// `render_widget` JSON DSL (column/row/grid/text/badge/progress/svg/button/…). Porting
/// that node-for-node to SwiftUI is a tracked follow-up; for now each render shows its
/// title + a raw spec preview so the pipeline is exercised end-to-end. See README.
struct CanvasView: View {
    @ObservedObject var store: WidgetStore

    var body: some View {
        List(store.widgets, id: \.id) { w in
            VStack(alignment: .leading, spacing: 6) {
                Text(w.title.isEmpty ? w.id : w.title).fontWeight(.medium)
                if let spec = w.spec, let json = prettyJSON(spec) {
                    Text(json).font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary).lineLimit(8)
                }
            }
        }
        .overlay { if store.widgets.isEmpty { ContentUnavailableCompat(text: "No canvases yet") } }
        .navigationTitle("Canvas")
    }

    private func prettyJSON(_ obj: JSONObject) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
