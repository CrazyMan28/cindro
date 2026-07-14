import SwiftUI

/// Settings: device name, local app toggles, daemon-side permission level, and unpair.
/// A subset of Android `ui/settings/SettingsScreen.kt` (voice library, autonomy knobs,
/// and provider API keys are follow-ups — see iphone_app/README.md parity table).
struct SettingsView: View {
    let repo: JarvisRepository
    @EnvironmentObject var app: AppState
    @StateObject private var vm: SettingsViewModel
    @State private var deviceName: String = ""

    init(repo: JarvisRepository) {
        self.repo = repo
        _vm = StateObject(wrappedValue: SettingsViewModel(repo: repo))
    }

    var body: some View {
        Form {
            Section("This device") {
                TextField("Device name", text: $deviceName)
                    .onSubmit { app.pairingStore.deviceName = deviceName }
                LabeledContent("Paired computer", value: app.pairingStore.hostPort ?? "—")
                if let fp = app.pairingStore.daemonFingerprint {
                    LabeledContent("Daemon id", value: fp).font(.caption)
                }
            }

            Section("Security") {
                Toggle("Require Face ID to open", isOn: Binding(
                    get: { app.gateEnabled }, set: { app.setGateEnabled($0) }))
                Toggle("Notifications", isOn: Binding(
                    get: { app.pairingStore.notificationsEnabled },
                    set: { app.pairingStore.notificationsEnabled = $0 }))
            }

            Section("Assistant") {
                Picker("Permission level", selection: Binding(
                    get: { vm.permissionLevel }, set: { vm.setPermissionLevel($0) })) {
                    ForEach(["high", "medium", "low"], id: \.self) { Text($0.capitalized).tag($0) }
                }
                if let brain = vm.defaultBrain { LabeledContent("Default brain", value: brain) }
                if let model = vm.defaultModel { LabeledContent("Default model", value: model) }
            }

            Section {
                Button("Unpair this device", role: .destructive) { vm.confirmUnpair = true }
            } footer: {
                Text("Removes the pairing and Ed25519 key link. You'll need to re-scan the QR code on your computer.")
            }
        }
        .navigationTitle("Settings")
        .onAppear { deviceName = app.pairingStore.deviceName }
        .task { await vm.load() }
        .alert("Unpair this device?", isPresented: $vm.confirmUnpair) {
            Button("Unpair", role: .destructive) { app.unpair() }
            Button("Cancel", role: .cancel) {}
        }
        .errorAlert($vm.errorText, title: "Couldn't update setting")
    }
}

@MainActor
final class SettingsViewModel: ObservableObject {
    @Published var permissionLevel = "medium"
    @Published var defaultBrain: String?
    @Published var defaultModel: String?
    @Published var confirmUnpair = false
    @Published var errorText: String?
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async {
        guard let s = try? await repo.settings() else { return }
        permissionLevel = s.str("permission_level") ?? "medium"
        defaultBrain = s.str("default_brain") ?? s.str("brain")
        defaultModel = s.str("default_model") ?? s.str("model")
    }

    /// `settings.set` is BIOMETRIC-tier — clear a Face ID prompt first (Android parity).
    func setPermissionLevel(_ level: String) {
        let previous = permissionLevel
        permissionLevel = level
        Task {
            guard await Biometric.authenticate(reason: "Change permission level") else {
                permissionLevel = previous; return
            }
            do { try await repo.setSettings(patch: ["permission_level": level]) }
            catch { errorText = error.localizedDescription; permissionLevel = previous }
        }
    }
}
