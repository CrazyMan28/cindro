import SwiftUI

/// The "Chats" list: all top-level sessions, create/open/delete. Port of Android
/// `ui/sessions/SessionsScreen.kt`.
struct SessionsView: View {
    let repo: JarvisRepository
    var onOpenSession: (String) -> Void
    @StateObject private var vm: SessionsViewModel

    init(repo: JarvisRepository, onOpenSession: @escaping (String) -> Void) {
        self.repo = repo
        self.onOpenSession = onOpenSession
        _vm = StateObject(wrappedValue: SessionsViewModel(repo: repo))
    }

    var body: some View {
        List {
            ConnectionBanner().listRowInsets(EdgeInsets())
            ForEach(vm.sessions) { s in
                Button { onOpenSession(s.id) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.displayTitle).foregroundStyle(.primary)
                        if let sub = s.brain ?? s.state {
                            Text(sub).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .onDelete { idx in Task { await vm.delete(at: idx) } }
        }
        .overlay { if vm.sessions.isEmpty && !vm.loading { ContentUnavailableCompat(text: "No chats yet") } }
        .navigationTitle("Chats")
        .toolbar { EditButton() }
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }
}

@MainActor
final class SessionsViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var loading = false
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async {
        loading = true; defer { loading = false }
        sessions = (try? await repo.listSessions())?.filter { !$0.isSubagent } ?? []
    }

    func delete(at offsets: IndexSet) async {
        let targets = offsets.map { sessions[$0] }
        for s in targets { try? await repo.delete(s.id) }
        await load()
    }
}

/// Small back-compat placeholder (avoids requiring iOS 17's `ContentUnavailableView`).
struct ContentUnavailableCompat: View {
    let text: String
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
            Text(text).foregroundStyle(.secondary)
        }
    }
}
