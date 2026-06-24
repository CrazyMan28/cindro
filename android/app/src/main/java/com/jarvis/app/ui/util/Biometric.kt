package com.jarvis.app.ui.util

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Gates `biometric`-tier actions (approval responses, take-over) behind the device
 * BiometricPrompt. Falls through to device-credential (PIN/pattern/password) when no
 * biometric is enrolled, and — if the device has no secure lock at all — allows the
 * action rather than hard-blocking the user out of their own assistant.
 */
object Biometric {

    private const val ALLOWED =
        BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

    fun isAvailable(activity: FragmentActivity): Boolean {
        val status = BiometricManager.from(activity).canAuthenticate(ALLOWED)
        return status == BiometricManager.BIOMETRIC_SUCCESS
    }

    /** Returns true if the user authenticated (or no secure lock exists to gate on). */
    suspend fun authenticate(
        activity: FragmentActivity,
        title: String,
        subtitle: String,
    ): Boolean {
        val manager = BiometricManager.from(activity)
        val strong = BiometricManager.Authenticators.BIOMETRIC_STRONG
        val weak = BiometricManager.Authenticators.BIOMETRIC_WEAK
        val cred = BiometricManager.Authenticators.DEVICE_CREDENTIAL

        // Prefer the actual FINGERPRINT (STRONG). Many devices — Samsung especially —
        // fail to DISPLAY the prompt when STRONG and DEVICE_CREDENTIAL are requested
        // together, which left the screen stuck on "Confirm your fingerprint…". Pick
        // the strongest authenticator that's actually enrolled, used on its own.
        val usable: Int = when {
            manager.canAuthenticate(strong) == BiometricManager.BIOMETRIC_SUCCESS -> strong
            manager.canAuthenticate(weak) == BiometricManager.BIOMETRIC_SUCCESS -> weak
            manager.canAuthenticate(cred) == BiometricManager.BIOMETRIC_SUCCESS -> cred
            // No secure lock configured at all — don't lock the user out of their daemon.
            else -> return true
        }

        return suspendCancellableCoroutine { cont ->
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (cont.isActive) cont.resume(false)
                    }

                    override fun onAuthenticationFailed() {
                        // keep prompt open; user can retry
                    }
                },
            )
            val builder = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(usable)
            // A negative ("Cancel") button is REQUIRED unless device-credential is the
            // chosen authenticator (which provides its own cancel affordance).
            if (usable != cred) builder.setNegativeButtonText("Cancel")
            try {
                prompt.authenticate(builder.build())
            } catch (t: Throwable) {
                // Never leave the UI stuck on the spinner if the prompt can't show.
                if (cont.isActive) cont.resume(false)
            }
        }
    }
}
