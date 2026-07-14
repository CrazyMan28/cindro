import SwiftUI

/// Pairing: scan the QR shown on the computer (Settings → Browser/Device) or type the
/// host:port + one-time code by hand. Port of Android `ui/pairing/PairScreen.kt`.
struct PairView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var vm = PairingViewModel()
    @State private var hostPort = PairingStore.defaultHostPort
    @State private var code = ""
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Pair with your computer").font(.title3.weight(.semibold))
                        Text("On the computer, open Cindro → Settings → Pair a device, then scan the QR code or enter the details below.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button { showScanner = true } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                }
                Section("Or enter manually") {
                    TextField("Computer address (host:port)", text: $hostPort)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Pairing code", text: $code)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button {
                        Task { await pair(hostPort: hostPort, code: code, fingerprint: nil) }
                    } label: {
                        if vm.pairing { ProgressView() } else { Text("Pair") }
                    }
                    .disabled(vm.pairing || code.isEmpty || hostPort.isEmpty)
                }
                if let err = vm.errorText {
                    Section { Text(err).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle("Cindro")
            .sheet(isPresented: $showScanner) {
                QRScannerView { scanned in
                    showScanner = false
                    if let payload = PairPayload.parse(scanned) {
                        hostPort = payload.hostPort
                        code = payload.code
                        Task { await pair(hostPort: payload.hostPort, code: payload.code, fingerprint: payload.fingerprint) }
                    } else {
                        vm.errorText = "That QR code isn't a Cindro pairing code."
                    }
                }
            }
        }
    }

    private func pair(hostPort: String, code: String, fingerprint: String?) async {
        let ok = await vm.pair(identity: app.identity, pairingStore: app.pairingStore,
                               hostPort: hostPort, code: code, scannedFingerprint: fingerprint)
        if ok { app.onPaired() }
    }
}

@MainActor
final class PairingViewModel: ObservableObject {
    @Published var pairing = false
    @Published var errorText: String?

    /// Run the one-shot pairing handshake; on success persist host/paired/fingerprint.
    /// Returns true iff paired.
    func pair(identity: DeviceIdentity, pairingStore: PairingStore,
              hostPort: String, code: String, scannedFingerprint: String?) async -> Bool {
        guard let hp = HostPort.parse(hostPort) else { errorText = "Invalid computer address."; return false }
        pairing = true; errorText = nil
        defer { pairing = false }

        let client = PairingClient(identity: identity)
        let result = await client.pair(wsUrl: hp.wsUrl(), code: code.trimmingCharacters(in: .whitespaces),
                                       deviceName: pairingStore.deviceName)
        switch result {
        case .paired(_, let fp):
            pairingStore.hostPort = "\(hp.host):\(hp.port)"
            pairingStore.isPaired = true
            pairingStore.daemonFingerprint = fp ?? scannedFingerprint
            return true
        case .failed(let reason):
            errorText = reason
            return false
        }
    }
}
