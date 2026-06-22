package com.jarvis.app

import android.app.Application
import com.jarvis.app.data.PairingStore
import com.jarvis.app.data.SecretStore

/**
 * Process-wide singletons. Kept deliberately small for the pairing-only milestone; the
 * session/queue/FCM machinery (Wave 3+) will hang off this same container.
 */
class JarvisApp : Application() {

    lateinit var secretStore: SecretStore
        private set

    lateinit var pairingStore: PairingStore
        private set

    override fun onCreate() {
        super.onCreate()
        secretStore = SecretStore(this)
        pairingStore = PairingStore(this)
    }
}
