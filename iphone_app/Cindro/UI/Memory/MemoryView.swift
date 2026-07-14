import SwiftUI

/// Memory: list / search / add / remove. Port of Android `ui/memory/MemoryScreen.kt`.
struct MemoryView: View {
    let repo: JarvisRepository
    @StateObject private var vm: MemoryViewModel
    @State private var query = ""
    @State private var showAdd = false
    @State private var newText = ""

    init(repo: JarvisRepository) {
        self.repo = repo
        _vm = StateObject(wrappedValue: MemoryViewModel(repo: repo))
    }

    var body: some View {
        List {
            ForEach(vm.entries) { m in
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.content)
                    if let t = m.target { Text(t).font(.caption2).foregroundStyle(.secondary) }
                }
            }
            .onDelete { idx in Task { await vm.remove(at: idx) } }
        }
        .searchable(text: $query)
        .onSubmit(of: .search) { Task { await vm.search(query) } }
        .onChange(of: query) { if $0.isEmpty { Task { await vm.load() } } }
        .overlay { if vm.entries.isEmpty { ContentUnavailableCompat(text: "No memories") } }
        .navigationTitle("Memory")
        .toolbar { Button { showAdd = true } label: { Image(systemName: "plus") } }
        .task { await vm.load() }
        .alert("Add memory", isPresented: $showAdd) {
            TextField("Fact to remember", text: $newText)
            Button("Save") { Task { await vm.add(newText); newText = "" } }
            Button("Cancel", role: .cancel) { newText = "" }
        }
    }
}

@MainActor
final class MemoryViewModel: ObservableObject {
    @Published var entries: [MemoryEntry] = []
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async { entries = (try? await repo.memoryList()) ?? [] }
    func search(_ q: String) async {
        guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { return await load() }
        entries = (try? await repo.memorySearch(q)) ?? []
    }
    func add(_ text: String) async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        try? await repo.memoryAdd(text: t, tags: ["phone"])
        await load()
    }
    func remove(at offsets: IndexSet) async {
        for m in offsets.map({ entries[$0] }) { try? await repo.memoryRemove(m.id) }
        await load()
    }
}
