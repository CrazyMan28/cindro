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

    /// True when this is the in-memory fallback minted because the Keychain couldn't be
    /// read (see [mintEphemeral]). The daemon has never seen this key, so auto-connecting
    /// with it would draw an auth-reject that force-unpairs the device — callers must NOT
    /// auto-connect an ephemeral identity, and must not treat its reject as a real
    /// deregistration. A persisted/loaded identity is always `false`.
    let isEphemeral: Bool

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
    ///
    /// A Keychain READ FAILURE (e.g. `errSecInteractionNotAllowed` before first unlock) must
    /// NOT be mistaken for "no identity": [Keychain.setString] persists via delete-then-add,
    /// so minting on a false "absent" would permanently wipe a still-present seed and break
    /// pairing. We therefore only mint-and-persist on a genuine `errSecItemNotFound` (or a
    /// present-but-unusable seed); on a real read error we return an ephemeral, NON-persisted
    /// identity, leaving the stored seed untouched for the next (readable) launch.
    static func loadOrCreate(_ keychain: Keychain) -> DeviceIdentity {
        let stored: String?
        do {
            stored = try keychain.readString(keySeed)
        } catch {
            return mintEphemeral()   // real read failure: never touch the stored seed
        }

        if let seedB64 = stored,
           let seed = Data(base64Encoded: seedB64),
           seed.count == 32,
           let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) {
            let pub = key.publicKey.rawRepresentation
            keychain.setString(pub.base64EncodedString(), for: keyPub) // keep cache in sync
            return DeviceIdentity(privateKey: key, publicKey: pub, isEphemeral: false)
        }

        // Genuine not-found (nil) or a present-but-unusable seed: safe to mint & persist.
        return mintAndPersist(keychain)
    }

    /// Mint a fresh identity and persist its seed — only safe when the Keychain read
    /// succeeded and genuinely reported no usable seed.
    private static func mintAndPersist(_ keychain: Keychain) -> DeviceIdentity {
        let key = Curve25519.Signing.PrivateKey()
        let seed = key.rawRepresentation           // 32-byte seed
        let pub = key.publicKey.rawRepresentation   // 32-byte public key
        keychain.setString(seed.base64EncodedString(), for: keySeed)
        keychain.setString(pub.base64EncodedString(), for: keyPub)
        return DeviceIdentity(privateKey: key, publicKey: pub, isEphemeral: false)
    }

    /// An in-memory-only identity used when the Keychain can't be read. Deliberately NOT
    /// persisted, so a transient read failure never overwrites the real stored seed.
    private static func mintEphemeral() -> DeviceIdentity {
        let key = Curve25519.Signing.PrivateKey()
        return DeviceIdentity(privateKey: key, publicKey: key.publicKey.rawRepresentation,
                              isEphemeral: true)
    }

    /// sha256(pubkey) → first 16 hex chars. Mirrors `DeviceRegistry::fingerprintFor`.
    static func fingerprintOf(_ pubkey: Data) -> String {
        let digest = SHA256.hash(data: pubkey)
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static let keySeed = "device_ed25519_seed"
    private static let keyPub = "device_ed25519_pub"
}
