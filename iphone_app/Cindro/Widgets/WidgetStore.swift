import Foundation
import Combine

/// Process-wide accumulator for `widget.render` / `widget.remove` / `widget.clear` events.
/// Lives for the app lifetime (owned by `AppState`) and subscribes at launch, so canvases
/// already rendered while you were on another screen are still there when you open Canvas —
/// the `widget.*` stream is push-only with no replay, so a per-screen subscriber would miss
/// them. Mirrors Android's process-wide widget catalog kept alive by the connection service.
@MainActor
final class WidgetStore: ObservableObject {
    @Published private(set) var widgets: [WidgetEvent] = []
    private var cancellable: AnyCancellable?

    init(events: PassthroughSubject<WidgetEvent, Never>) {
        cancellable = events.receive(on: RunLoop.main).sink { [weak self] in self?.apply($0) }
    }

    private func apply(_ ev: WidgetEvent) {
        switch ev.op {
        case "clear":  widgets.removeAll()
        case "remove": widgets.removeAll { $0.id == ev.id }
        default:       // render — replace by id for live updates
            if let idx = widgets.firstIndex(where: { $0.id == ev.id }) { widgets[idx] = ev }
            else { widgets.append(ev) }
        }
    }
}
