import SwiftUI

/// The Claude/ChatGPT-style sidebar: brand + connection pill, "New chat", the 13
/// destinations, and a "Recents" list of non-subagent sessions. Port of Android
/// `ui/drawer/AppDrawer.kt`.
struct AppDrawer: View {
    let repo: JarvisRepository
    let current: Route
    var onSelect: (Route) -> Void
    var onOpenSession: (String) -> Void
    @StateObject private var vm: HomeViewModel

    init(repo: JarvisRepository, current: Route,
         onSelect: @escaping (Route) -> Void, onOpenSession: @escaping (String) -> Void) {
        self.repo = repo
        self.current = current
        self.onSelect = onSelect
        self.onOpenSession = onOpenSession
        _vm = StateObject(wrappedValue: HomeViewModel(repo: repo))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "sparkle").foregroundStyle(.tint)
                Text("Cindro").font(.title3.weight(.bold))
                Spacer()
            }
            .padding()
            ConnectionBanner()

            List {
                Button { onSelect(.chatHome) } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                }
                Section {
                    ForEach(Route.allCases.filter { $0 != .chatHome }) { r in
                        Button { onSelect(r) } label: {
                            Label(r.title, systemImage: r.icon)
                                .fontWeight(current == r ? .semibold : .regular)
                        }
                        .listRowBackground(current == r ? Color.accentColor.opacity(0.12) : nil)
                    }
                }
                if !vm.sessions.isEmpty {
                    Section("Recents") {
                        ForEach(vm.sessions.prefix(12)) { s in
                            Button { onOpenSession(s.id) } label: {
                                Text(s.displayTitle).lineLimit(1)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
        .background(Color(.systemBackground))
        .task { await vm.loadSessions() }
    }
}
