package com.jarvis.app

import android.app.Application
import com.jarvis.app.crypto.DeviceIdentity
import com.jarvis.app.data.PairingStore
import com.jarvis.app.data.SecretStore
import com.jarvis.app.fcm.JarvisNotifier
import com.jarvis.app.net.JarvisRepository

/**
 * Process-wide singletons. The device identity (Ed25519 keypair), secret/pairing stores
 * and the daemon repository all hang off this container so screens and the FCM service
 * share one connection and one device key.
 */
class JarvisApp : Application() {

    lateinit var secretStore: SecretStore
        private set

    lateinit var pairingStore: PairingStore
        private set

    lateinit var identity: DeviceIdentity
        private set

    lateinit var repository: JarvisRepository
        private set

    override fun onCreate() {
        super.onCreate()
        secretStore = SecretStore(this)
        pairingStore = PairingStore(this)
        identity = DeviceIdentity.loadOrCreate(secretStore)
        repository = JarvisRepository(identity, pairingStore, secretStore)
        JarvisNotifier.ensureChannels(this)

        // If the user already paired in a previous run, bring the socket up eagerly so
        // sessions/queue load without a manual reconnect.
        if (pairingStore.isPaired) repository.connect()
    }
}
