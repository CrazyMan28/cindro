package com.jarvis.app.crypto

import android.util.Base64
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import com.jarvis.app.data.SecretStore
import java.security.MessageDigest

/**
 * The phone's long-lived Ed25519 device identity used by the Contract C handshake.
 *
 * We use Tink's raw [Ed25519Sign] / [Ed25519Verify] subtle primitives (NOT keyset
 * handles) because the daemon verifies with libsodium `crypto_sign_verify_detached`,
 * which expects a bare 32-byte public key and a bare 64-byte detached signature — the
 * exact wire shape these primitives produce. (A Tink keyset would prepend a key-id
 * prefix and break verification.)
 *
 * Key material:
 *  - private seed (32 bytes) is generated once, base64-encoded, and stored in
 *    [SecretStore] (AndroidKeystore-backed EncryptedSharedPreferences).
 *  - the public key (32 bytes) is derived from the seed and cached alongside it.
 *
 * The device id advertised to the daemon is the fingerprint of the public key:
 * sha256(pubkey) -> first 16 hex chars, matching DeviceRegistry::fingerprintFor.
 */
class DeviceIdentity private constructor(
    private val seed: ByteArray,
    val publicKey: ByteArray,
) {

    /** Raw Ed25519 public key, base64 (NO_WRAP) — sent in the `hello` frame. */
    val publicKeyB64: String get() = Base64.encodeToString(publicKey, Base64.NO_WRAP)

    /** sha256(pubkey) first 16 hex chars — the stable device id used by the daemon. */
    val fingerprint: String get() = fingerprintOf(publicKey)

    /** Detached Ed25519 signature (64 bytes) over [message], base64 (NO_WRAP). */
    fun sign(message: ByteArray): String {
        val signer = Ed25519Sign(seed)
        return Base64.encodeToString(signer.sign(message), Base64.NO_WRAP)
    }

    companion object {
        private const val KEY_SEED = "device_ed25519_seed"
        private const val KEY_PUB = "device_ed25519_pub"

        /**
         * Load the persisted identity or mint a new one on first use. The keypair is
         * deterministic from the seed, so we re-derive the public key from the stored
         * seed and only fall back to the cached public key if derivation is impossible.
         */
        fun loadOrCreate(secretStore: SecretStore): DeviceIdentity {
            val existingSeed = secretStore.getString(KEY_SEED)?.let { decode(it) }
            if (existingSeed != null && existingSeed.size == 32) {
                val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(existingSeed)
                val pub = kp.publicKey
                // Keep the cached public key in sync (cheap, idempotent).
                secretStore.putString(KEY_PUB, Base64.encodeToString(pub, Base64.NO_WRAP))
                return DeviceIdentity(existingSeed, pub)
            }

            val kp = Ed25519Sign.KeyPair.newKeyPair()
            // Tink's KeyPair exposes the 32-byte private key (the seed for raw Ed25519).
            val newSeed = kp.privateKey
            val pub = kp.publicKey
            secretStore.putString(KEY_SEED, Base64.encodeToString(newSeed, Base64.NO_WRAP))
            secretStore.putString(KEY_PUB, Base64.encodeToString(pub, Base64.NO_WRAP))
            return DeviceIdentity(newSeed, pub)
        }

        /** sha256(pubkey) -> first 16 hex chars. Mirrors DeviceRegistry::fingerprintFor. */
        fun fingerprintOf(pubkey: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(pubkey)
            val sb = StringBuilder(16)
            for (i in 0 until 8) sb.append("%02x".format(digest[i]))
            return sb.toString()
        }

        private fun decode(b64: String): ByteArray? =
            runCatching { Base64.decode(b64, Base64.NO_WRAP) }.getOrNull()
    }
}
