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
        val status = manager.canAuthenticate(ALLOWED)
        if (status == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ||
            status == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED
        ) {
            // No secure lock configured — do not lock the user out of their own daemon.
            return true
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
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(ALLOWED)
                .build()
            prompt.authenticate(info)
        }
    }
}
