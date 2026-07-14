import SwiftUI

/// Queue: scheduled / queued tasks. Port of Android `ui/queue/QueueScreen.kt`.
struct QueueView: View {
    let repo: JarvisRepository
    @StateObject private var vm: QueueViewModel
    @State private var showAdd = false
    @State private var text = ""
    @State private var when = ""

    init(repo: JarvisRepository) {
        self.repo = repo
        _vm = StateObject(wrappedValue: QueueViewModel(repo: repo))
    }

    var body: some View {
        List(vm.tasks) { t in
            VStack(alignment: .leading, spacing: 2) {
                Text(t.text)
                HStack(spacing: 8) {
                    if let s = t.state { Text(s).font(.caption2).foregroundStyle(.secondary) }
                    if let w = t.whenAt { Text(w).font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
        .overlay { if vm.tasks.isEmpty { ContentUnavailableCompat(text: "Queue is empty") } }
        .navigationTitle("Queue")
        .toolbar { Button { showAdd = true } label: { Image(systemName: "plus") } }
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .alert("Queue a task", isPresented: $showAdd) {
            TextField("What should Cindro do?", text: $text)
            TextField("When (optional, e.g. 9am)", text: $when)
            Button("Queue") { Task { await vm.add(text: text, when: when); text = ""; when = "" } }
            Button("Cancel", role: .cancel) {}
        }
    }
}

@MainActor
final class QueueViewModel: ObservableObject {
    @Published var tasks: [QueuedTask] = []
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async { tasks = (try? await repo.listTasks()) ?? [] }
    func add(text: String, when: String) async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        try? await repo.queueTask(text: t, when: when.isEmpty ? nil : when)
        await load()
    }
}
