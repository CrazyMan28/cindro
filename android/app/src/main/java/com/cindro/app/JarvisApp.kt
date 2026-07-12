package com.cindro.app

import android.app.Application
import com.cindro.app.crypto.DeviceIdentity
import com.cindro.app.data.AppPrefs
import com.cindro.app.data.PairingStore
import com.cindro.app.data.SecretStore
import com.cindro.app.data.VoiceSettings
import com.cindro.app.fcm.JarvisNotifier
import com.cindro.app.files.FileReceiver
import com.cindro.app.net.JarvisRepository
import com.cindro.app.voice.TtsPlayer

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

    lateinit var voiceSettings: VoiceSettings
        private set

    lateinit var appPrefs: AppPrefs
        private set

    /** Process-wide TTS player so replies keep playing across screen navigation. */
    val ttsPlayer: TtsPlayer by lazy { TtsPlayer(this) }

    lateinit var fileReceiver: FileReceiver
        private set

    override fun onCreate() {
        super.onCreate()
        secretStore = SecretStore(this)
        pairingStore = PairingStore(this)
        voiceSettings = VoiceSettings(this)
        appPrefs = AppPrefs(this)
        identity = DeviceIdentity.loadOrCreate(secretStore)
        repository = JarvisRepository(identity, pairingStore, secretStore)
        fileReceiver = FileReceiver(this, repository)
        fileReceiver.start()
        JarvisNotifier.ensureChannels(this)

        // If the user already paired in a previous run, bring the socket up eagerly so
        // sessions/queue load without a manual reconnect.
        if (pairingStore.isPaired) repository.connect()
    }
}
