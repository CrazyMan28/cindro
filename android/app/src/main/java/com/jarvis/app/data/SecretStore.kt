package com.jarvis.app.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * EncryptedSharedPreferences-backed store for device-bound secrets: the paired-host bearer
 * token and (later) the device's signing-key material used by the Contract C handshake.
 *
 * Falls back to a plain [SharedPreferences] file if the AndroidKeyStore master key cannot be
 * minted (seen on some emulators / freshly-wiped devices). The fallback is logged once.
 */
class SecretStore(context: Context) {

    private val prefs: SharedPreferences = runCatching {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse { e ->
        Log.w(TAG, "Encrypted storage unavailable; falling back to plain prefs", e)
        context.getSharedPreferences("${FILE_NAME}_plain", Context.MODE_PRIVATE)
    }

    fun putString(key: String, value: String?) {
        prefs.edit().apply {
            if (value == null) remove(key) else putString(key, value)
        }.apply()
    }

    fun getString(key: String): String? = prefs.getString(key, null)

    fun clear(key: String) = prefs.edit().remove(key).apply()

    companion object {
        private const val TAG = "SecretStore"

        // Must match the path excluded in res/xml/backup_rules.xml.
        const val FILE_NAME = "jarvis_secret_store"

        const val KEY_DEVICE_TOKEN = "device_token"
    }
}
