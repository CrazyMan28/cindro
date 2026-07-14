import SwiftUI

/// "What Cindro may do over the phone" — the device-exposed capability map
/// (`phone.policy.list` / `phone.policy.set`). Port of Android `PhonePermissionsScreen`.
/// Boolean capabilities render as toggles; anything else shows read-only.
struct PhonePermissionsView: View {
    let repo: JarvisRepository
    @StateObject private var vm: PhonePermissionsViewModel

    init(repo: JarvisRepository) {
        self.repo = repo
        _vm = StateObject(wrappedValue: PhonePermissionsViewModel(repo: repo))
    }

    var body: some View {
        List {
            ForEach(vm.items, id: \.key) { item in
                if let flag = item.value as? Bool {
                    Toggle(item.label, isOn: Binding(get: { flag }, set: { on in Task { await vm.set(item.key, on) } }))
                } else {
                    LabeledContent(item.label, value: String(describing: item.value))
                }
            }
            Section {
                Button("Reset to defaults") { Task { await vm.reset() } }
            }
        }
        .overlay { if vm.items.isEmpty { ContentUnavailableCompat(text: "No phone subsystem") } }
        .navigationTitle("Phone permissions")
        .task { await vm.load() }
    }
}

struct PhoneCapability { let key: String; let label: String; let value: Any }

@MainActor
final class PhonePermissionsViewModel: ObservableObject {
    @Published var items: [PhoneCapability] = []
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async {
        guard let map = try? await repo.phonePolicyList() else { items = []; return }
        // The enriched capability map is either a flat dict or {policies:[{id,label,value}]}.
        if let arr = map.objArr("policies") {
            items = arr.compactMap { o in
                guard let id = o.str("id") else { return nil }
                return PhoneCapability(key: id, label: o.str("label") ?? id, value: o["value"] ?? false)
            }
        } else {
            items = map.keys.sorted().map { PhoneCapability(key: $0, label: $0.replacingOccurrences(of: "_", with: " ").capitalized, value: map[$0] ?? "") }
        }
    }
    func set(_ id: String, _ value: Any) async { try? await repo.phonePolicySet(id: id, value: value); await load() }
    func reset() async { try? await repo.phonePolicyReset(); await load() }
}
