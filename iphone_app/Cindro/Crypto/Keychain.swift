import Foundation
import Security

/// Thin wrapper over the iOS Keychain for the one secret we hold: the 32-byte Ed25519
/// device seed. Mirrors Android's `SecretStore` (AndroidKeystore-backed
/// EncryptedSharedPreferences) — key material never lives in UserDefaults / plist.
///
/// Values are stored as generic passwords under a fixed service, readable only after
/// first device unlock (`kSecAttrAccessibleAfterFirstThisDeviceOnly`) and never synced
/// to iCloud, so the identity is bound to this physical phone the way the Android seed is.
struct Keychain {
    let service: String

    init(service: String = "com.cindro.app.secret") {
        self.service = service
    }

    func getString(_ key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    func setString(_ value: String, for key: String) -> Bool {
        let data = Data(value.utf8)
        // Delete-then-add keeps the call idempotent (SecItemUpdate can't create).
        SecItemDelete(baseQuery(key) as CFDictionary)
        var add = baseQuery(key)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    func delete(_ key: String) -> Bool {
        SecItemDelete(baseQuery(key) as CFDictionary) == errSecSuccess
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}
