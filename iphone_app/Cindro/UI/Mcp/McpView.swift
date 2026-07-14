import SwiftUI

/// MCP servers: enable/disable, test, remove, plus per-brain CLI MCP toggles. Port of
/// Android `ui/mcp/McpScreen.kt` (the add-server form is BIOMETRIC-tier; a follow-up).
struct McpView: View {
    let repo: JarvisRepository
    @StateObject private var vm: McpViewModel

    init(repo: JarvisRepository) {
        self.repo = repo
        _vm = StateObject(wrappedValue: McpViewModel(repo: repo))
    }

    var body: some View {
        List {
            Section("Servers") {
                ForEach(vm.servers) { s in
                    VStack(alignment: .leading, spacing: 4) {
                        Toggle(isOn: Binding(get: { s.enabled }, set: { on in Task { await vm.setEnabled(s, on) } })) {
                            Text(s.name)
                        }
                        if let url = s.url ?? s.command { Text(url).font(.caption2).foregroundStyle(.secondary) }
                        if let st = vm.testStatus[s.name] { Text(st).font(.caption2).foregroundStyle(.secondary) }
                    }
                    .swipeActions {
                        Button { Task { await vm.test(s) } } label: { Label("Test", systemImage: "bolt") }.tint(.blue)
                        Button(role: .destructive) { Task { await vm.remove(s) } } label: { Label("Remove", systemImage: "trash") }
                    }
                }
                if vm.servers.isEmpty { Text("No MCP servers").foregroundStyle(.secondary) }
            }
            if !vm.cli.isEmpty {
                Section("CLI MCP (per brain)") {
                    ForEach(vm.cli) { c in
                        Toggle(isOn: Binding(get: { c.enabled }, set: { on in Task { await vm.setCliEnabled(c, on) } })) {
                            VStack(alignment: .leading) {
                                Text(c.name)
                                Text(c.brain).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("MCP servers")
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }
}

@MainActor
final class McpViewModel: ObservableObject {
    @Published var servers: [McpServer] = []
    @Published var cli: [CliMcp] = []
    @Published var testStatus: [String: String] = [:]
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async {
        servers = (try? await repo.mcpList()) ?? []
        cli = (try? await repo.mcpCliList()) ?? []
    }
    func setEnabled(_ s: McpServer, _ on: Bool) async { try? await repo.mcpSetEnabled(s.name, on); await load() }
    func remove(_ s: McpServer) async { try? await repo.mcpRemove(s.name); await load() }
    func test(_ s: McpServer) async { testStatus[s.name] = (try? await repo.mcpTest(s.name)) ?? "failed" }
    func setCliEnabled(_ c: CliMcp, _ on: Bool) async {
        try? await repo.mcpCliSetEnabled(brain: c.brain, name: c.name, enabled: on); await load()
    }
}
