import Foundation
import LocalAuthentication

/// Face ID / Touch ID / passcode gate. Port of Android's `ui/util/Biometric.kt`.
///
/// **Fail-open**: when the device has no secure lock enrolled at all, `authenticate`
/// returns `true` rather than bricking the user out of their own app — the exact
/// behaviour the Android side chose (`Biometric.authenticate` returns true when no
/// secure lock exists).
enum Biometric {
    static func authenticate(reason: String) async -> Bool {
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "Enter passcode"
        var error: NSError?
        // `.deviceOwnerAuthentication` = biometrics with automatic passcode fallback.
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // Fail OPEN only when there is genuinely no secure lock enrolled
            // (`.passcodeNotSet`) — the anti-brick case. Any other reason (MDM policy,
            // hardware restriction, biometry lockout) fails CLOSED rather than bypassing.
            if let laError = error as? LAError, laError.code == .passcodeNotSet {
                return true
            }
            return false
        }
        return await withCheckedContinuation { cont in
            ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
                cont.resume(returning: ok)
            }
        }
    }
}
