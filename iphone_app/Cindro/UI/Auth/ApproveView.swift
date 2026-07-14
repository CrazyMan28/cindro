import SwiftUI

/// The phone leg of cross-device 2FA unlock. A desktop/Chrome sign-in pushes an
/// `auth.challenge` over the authed socket (the possession factor); the user clears a
/// biometric prompt (the 2nd factor) → `auth.approve`. Port of Android `ui/auth/ApproveScreen.kt`.
///
/// Deliberately shown OVER the app-open gate (it runs its own prompt) — matching the
/// Android `APPROVE` route being outside the `Gated` wrapper.
struct ApproveView: View {
    let challenge: AuthChallenge
    @EnvironmentObject var app: AppState
    @State private var working = false
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "lock.open.rotation")
                .font(.system(size: 52, weight: .light)).foregroundStyle(.tint)
            Text("Unlock request").font(.title2.weight(.semibold))
            Text(challenge.summary).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Spacer()
            if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
            HStack {
                Button("Deny", role: .destructive) { Task { await respond(approve: false) } }
                    .buttonStyle(.bordered)
                Button("Approve with Face ID") { Task { await respond(approve: true) } }
                    .buttonStyle(.borderedProminent)
            }
            .disabled(working)
            .padding(.bottom)
        }
        .padding()
    }

    private func respond(approve: Bool) async {
        guard !working else { return }
        working = true; defer { working = false }
        do {
            if approve {
                guard await Biometric.authenticate(reason: "Approve sign-in") else { return }
                try await app.repository.authApprove(challengeId: challenge.challengeId)
                app.unlock()   // present at an unlocked phone → skip a double app-open prompt
            } else {
                try await app.repository.authDeny(challengeId: challenge.challengeId)
            }
            app.pendingChallenge = nil
        } catch {
            errorText = error.localizedDescription
        }
    }
}
