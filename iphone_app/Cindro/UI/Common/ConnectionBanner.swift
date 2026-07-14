import SwiftUI

/// A slim status pill shown while the device socket is not fully connected, plus the
/// dismissible daemon-identity mismatch warning. Reads live state off the `DeviceClient`.
struct ConnectionBanner: View {
    @EnvironmentObject var app: AppState
    var body: some View { ConnectionBannerInner(client: app.repository.client) }
}

private struct ConnectionBannerInner: View {
    @ObservedObject var client: DeviceClient

    var body: some View {
        VStack(spacing: 0) {
            if client.state != .connected {
                HStack(spacing: 8) {
                    if client.state == .connecting || client.state == .handshaking {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "wifi.slash")
                    }
                    Text(label).font(.caption)
                    Spacer()
                }
                .padding(.horizontal).padding(.vertical, 6)
                .background(Color(.secondarySystemBackground))
            }
            if let warning = client.identityWarning {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.shield")
                    Text(warning).font(.caption2)
                    Spacer()
                    Button("Dismiss") { client.dismissIdentityWarning() }.font(.caption2)
                }
                .padding(.horizontal).padding(.vertical, 6)
                .background(Color.orange.opacity(0.15))
            }
        }
    }

    private var label: String {
        switch client.state {
        case .connecting: return "Connecting…"
        case .handshaking: return "Authenticating…"
        case .error: return client.lastError ?? "Disconnected"
        case .disconnected: return "Disconnected"
        case .connected: return ""
        }
    }
}
