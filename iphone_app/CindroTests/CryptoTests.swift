import XCTest
import CryptoKit
@testable import Cindro

/// Validates the Ed25519 wire shape the daemon's libsodium `crypto_sign_verify_detached`
/// requires: a bare 32-byte public key, a bare 64-byte detached signature, and the
/// `sha256(pubkey)`-first-16-hex device fingerprint.
final class CryptoTests: XCTestCase {

    func testFingerprintIs16HexOfSha256Prefix() {
        let pub = Data((0..<32).map { UInt8($0) })
        let fp = DeviceIdentity.fingerprintOf(pub)
        XCTAssertEqual(fp.count, 16)
        let expected = SHA256.hash(data: pub).prefix(8).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(fp, expected)
    }

    func testCurve25519ProducesBareDetachedSignature() throws {
        // Mirrors DeviceIdentity.sign — a 64-byte detached signature over the raw nonce,
        // verifiable with the bare 32-byte public key (what the daemon does).
        let key = Curve25519.Signing.PrivateKey()
        XCTAssertEqual(key.publicKey.rawRepresentation.count, 32)
        let nonce = Data("challenge-nonce".utf8)
        let sig = try key.signature(for: nonce)
        XCTAssertEqual(sig.count, 64)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: nonce))
    }

    func testSeedRoundTripDerivesSamePublicKey() throws {
        let key = Curve25519.Signing.PrivateKey()
        let seed = key.rawRepresentation
        let restored = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(key.publicKey.rawRepresentation, restored.publicKey.rawRepresentation)
    }
}
