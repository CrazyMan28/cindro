import SwiftUI
import Combine

/// Canvas: a gallery of model-rendered widgets/canvases forwarded over the socket
/// (`widget.render` / `widget.remove` / `widget.clear`). Port of Android
/// `ui/canvas/CanvasScreen.kt`.
///
/// NOTE (parity gap): Android's `WidgetRenderer` is a full recursive interpreter for the
/// `render_widget` JSON DSL (column/row/grid/text/badge/progress/svg/button/…). Porting
/// that node-for-node to SwiftUI is a tracked follow-up; for now each render shows its
/// title + a raw spec preview so the pipeline is exercised end-to-end. See README.
struct CanvasView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var vm = CanvasViewModel()

    var body: some View {
        List(vm.widgets, id: \.id) { w in
            VStack(alignment: .leading, spacing: 6) {
                Text(w.title.isEmpty ? w.id : w.title).fontWeight(.medium)
                if let spec = w.spec, let json = prettyJSON(spec) {
                    Text(json).font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary).lineLimit(8)
                }
            }
        }
        .overlay { if vm.widgets.isEmpty { ContentUnavailableCompat(text: "No canvases yet") } }
        .navigationTitle("Canvas")
        .onAppear { vm.bind(app.repository.client.widgetEvents) }
    }

    private func prettyJSON(_ obj: JSONObject) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

@MainActor
final class CanvasViewModel: ObservableObject {
    @Published var widgets: [WidgetEvent] = []
    private var cancellable: AnyCancellable?

    func bind(_ publisher: PassthroughSubject<WidgetEvent, Never>) {
        guard cancellable == nil else { return }
        cancellable = publisher.receive(on: RunLoop.main).sink { [weak self] ev in self?.apply(ev) }
    }

    private func apply(_ ev: WidgetEvent) {
        switch ev.op {
        case "clear": widgets.removeAll()
        case "remove": widgets.removeAll { $0.id == ev.id }
        default:  // render — replace by id for live updates
            if let idx = widgets.firstIndex(where: { $0.id == ev.id }) { widgets[idx] = ev }
            else { widgets.append(ev) }
        }
    }
}
