import Foundation
import UIKit

/// Non-secret pairing preferences: the daemon host:port, whether pairing has completed,
/// the pinned daemon public-key fingerprint, this device's human name, and the user's
/// notification preference. Signing-key material lives in [Keychain], never here.
/// Port of Android's `com.cindro.app.data.PairingStore` (backed by SharedPreferences;
/// UserDefaults is the iOS equivalent).
final class PairingStore {
    static let defaultHostPort = "127.0.0.1:8796"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hostPort: String? {
        get { defaults.string(forKey: Keys.hostPort) }
        set { defaults.set(newValue, forKey: Keys.hostPort) }
    }

    var isPaired: Bool {
        get { defaults.bool(forKey: Keys.paired) }
        set { defaults.set(newValue, forKey: Keys.paired) }
    }

    /// Pinned daemon ed25519 public-key fingerprint from the pairing payload (advisory).
    var daemonFingerprint: String? {
        get { defaults.string(forKey: Keys.fingerprint) }
        set { defaults.set(newValue, forKey: Keys.fingerprint) }
    }

    /// Human label this device advertises in the `hello` frame.
    var deviceName: String {
        get { defaults.string(forKey: Keys.name) ?? Self.defaultDeviceName() }
        set { defaults.set(newValue, forKey: Keys.name) }
    }

    var notificationsEnabled: Bool {
        get { defaults.object(forKey: Keys.notifs) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Keys.notifs) }
    }

    func clearPairing() {
        defaults.set(false, forKey: Keys.paired)
        defaults.removeObject(forKey: Keys.fingerprint)
    }

    private static func defaultDeviceName() -> String {
        let name = UIDevice.current.name
        return name.isEmpty ? "iPhone" : name
    }

    private enum Keys {
        static let hostPort = "host_port"
        static let paired = "paired"
        static let fingerprint = "daemon_fp"
        static let name = "device_name"
        static let notifs = "notifications_enabled"
    }
}
