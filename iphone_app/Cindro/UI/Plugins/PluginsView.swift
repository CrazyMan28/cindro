import SwiftUI

/// Plugins: catalog install / enable / remove. Port of Android `ui/plugins/PluginsScreen.kt`.
struct PluginsView: View {
    let repo: JarvisRepository
    @StateObject private var vm: PluginsViewModel

    init(repo: JarvisRepository) {
        self.repo = repo
        _vm = StateObject(wrappedValue: PluginsViewModel(repo: repo))
    }

    var body: some View {
        List(vm.plugins) { p in
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(p.name ?? p.id).fontWeight(.medium)
                    if let v = p.version { Text(v).font(.caption2).foregroundStyle(.secondary) }
                    Spacer()
                    if p.installed {
                        Toggle("", isOn: Binding(get: { p.enabled }, set: { on in Task { await vm.setEnabled(p, on) } }))
                            .labelsHidden()
                    } else {
                        Button("Install") { Task { await vm.install(p) } }.buttonStyle(.bordered).controlSize(.small)
                    }
                }
                if let d = p.description { Text(d).font(.caption).foregroundStyle(.secondary) }
            }
            .swipeActions {
                if p.installed {
                    Button(role: .destructive) { Task { await vm.remove(p) } } label: { Label("Remove", systemImage: "trash") }
                }
            }
        }
        .overlay { if vm.plugins.isEmpty { ContentUnavailableCompat(text: "No plugins") } }
        .navigationTitle("Plugins")
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }
}

@MainActor
final class PluginsViewModel: ObservableObject {
    @Published var plugins: [Plugin] = []
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async { plugins = (try? await repo.pluginCatalog()) ?? [] }
    func install(_ p: Plugin) async { try? await repo.pluginInstall(p.id); await load() }
    func setEnabled(_ p: Plugin, _ on: Bool) async { try? await repo.pluginSetEnabled(p.id, on); await load() }
    func remove(_ p: Plugin) async { try? await repo.pluginRemove(p.id); await load() }
}
