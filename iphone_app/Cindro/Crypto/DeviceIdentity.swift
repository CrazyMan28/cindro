import Foundation
import CryptoKit

/// The phone's long-lived Ed25519 device identity used by the Contract C handshake.
///
/// Port of Android's `com.cindro.app.crypto.DeviceIdentity`. We use CryptoKit's
/// `Curve25519.Signing` primitives, which produce exactly the bare wire shape the daemon
/// verifies with libsodium `crypto_sign_verify_detached`:
///   - `publicKey.rawRepresentation` is a bare 32-byte public key.
///   - `signature(for:)` is a bare 64-byte detached signature.
/// (No key-id prefix, no ASN.1 wrapping — same reason the Android side uses Tink's raw
/// `Ed25519Sign` subtle primitive rather than a keyset handle.)
///
/// Key material:
///   - the 32-byte private seed (`rawRepresentation`) is generated once and stored in the
///     [Keychain]; the private key is deterministic from it.
///   - the public key (32 bytes) is derived from the seed.
///
/// The device id advertised to the daemon is `sha256(pubkey)` → first 16 hex chars,
/// matching `DeviceRegistry::fingerprintFor` on the daemon and the Android app.
struct DeviceIdentity {
    private let privateKey: Curve25519.Signing.PrivateKey
    let publicKey: Data

    /// Raw Ed25519 public key, base64 (no line wrapping) — sent in the `hello` frame.
    var publicKeyB64: String { publicKey.base64EncodedString() }

    /// sha256(pubkey) first 16 hex chars — the stable device id used by the daemon.
    var fingerprint: String { Self.fingerprintOf(publicKey) }

    /// Detached Ed25519 signature (64 bytes) over `message`, base64 (no wrapping).
    /// Signing a raw key can't actually fail; a defensive empty string beats a crash.
    func sign(_ message: Data) -> String {
        guard let sig = try? privateKey.signature(for: message) else { return "" }
        return sig.base64EncodedString()
    }

    /// Load the persisted identity or mint a new one on first use.
    static func loadOrCreate(_ keychain: Keychain) -> DeviceIdentity {
        if let seedB64 = keychain.getString(keySeed),
           let seed = Data(base64Encoded: seedB64),
           seed.count == 32,
           let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) {
            let pub = key.publicKey.rawRepresentation
            keychain.setString(pub.base64EncodedString(), for: keyPub) // keep cache in sync
            return DeviceIdentity(privateKey: key, publicKey: pub)
        }

        let key = Curve25519.Signing.PrivateKey()
        let seed = key.rawRepresentation           // 32-byte seed
        let pub = key.publicKey.rawRepresentation   // 32-byte public key
        keychain.setString(seed.base64EncodedString(), for: keySeed)
        keychain.setString(pub.base64EncodedString(), for: keyPub)
        return DeviceIdentity(privateKey: key, publicKey: pub)
    }

    /// sha256(pubkey) → first 16 hex chars. Mirrors `DeviceRegistry::fingerprintFor`.
    static func fingerprintOf(_ pubkey: Data) -> String {
        let digest = SHA256.hash(data: pubkey)
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static let keySeed = "device_ed25519_seed"
    private static let keyPub = "device_ed25519_pub"
}
