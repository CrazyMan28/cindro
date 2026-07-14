import SwiftUI

/// Agents: list custom subagents; dispatch opens the child chat. Port of Android
/// `ui/agents/AgentsScreen.kt` (create form is a follow-up).
struct AgentsView: View {
    let repo: JarvisRepository
    var onOpenSession: (String) -> Void
    @StateObject private var vm: AgentsViewModel
    @State private var dispatchTarget: Agent?
    @State private var task = ""

    init(repo: JarvisRepository, onOpenSession: @escaping (String) -> Void) {
        self.repo = repo
        self.onOpenSession = onOpenSession
        _vm = StateObject(wrappedValue: AgentsViewModel(repo: repo))
    }

    var body: some View {
        List {
            ForEach(vm.agents) { agent in
                VStack(alignment: .leading, spacing: 4) {
                    Text(agent.name).fontWeight(.medium)
                    if let d = agent.description { Text(d).font(.caption).foregroundStyle(.secondary) }
                    if let w = agent.whenToUse { Text("When: \(w)").font(.caption2).foregroundStyle(.secondary) }
                }
                .swipeActions {
                    Button { dispatchTarget = agent; task = "" } label: { Label("Dispatch", systemImage: "paperplane") }
                        .tint(.blue)
                }
            }
        }
        .overlay { if vm.agents.isEmpty { ContentUnavailableCompat(text: "No agents") } }
        .navigationTitle("Agents")
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .alert("Dispatch \(dispatchTarget?.name ?? "")", isPresented: Binding(
            get: { dispatchTarget != nil }, set: { if !$0 { dispatchTarget = nil } })) {
            TextField("Task", text: $task)
            Button("Dispatch") {
                if let a = dispatchTarget {
                    Task {
                        if let sid = await vm.dispatch(a, task: task), !sid.isEmpty { onOpenSession(sid) }
                        dispatchTarget = nil
                    }
                }
            }
            Button("Cancel", role: .cancel) { dispatchTarget = nil }
        }
    }
}

@MainActor
final class AgentsViewModel: ObservableObject {
    @Published var agents: [Agent] = []
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async { agents = (try? await repo.agentsList()) ?? [] }
    func dispatch(_ a: Agent, task: String) async -> String? {
        try? await repo.agentDispatch(agent: a.name, task: task, parentSessionId: nil)
    }
}
