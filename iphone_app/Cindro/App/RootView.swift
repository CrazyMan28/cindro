import SwiftUI

/// Top-level routing: pairing → biometric gate → main shell. A pending cross-device
/// unlock challenge is presented over everything (it runs its own biometric prompt, so
/// it is deliberately not behind the app-open gate — mirrors Android's `APPROVE` route).
struct RootView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        Group {
            if !app.isPaired {
                PairView()
            } else if app.gateEnabled && !app.appUnlocked {
                GateView()
            } else {
                MainShell()
            }
        }
        .fullScreenCover(item: $app.pendingChallenge) { challenge in
            ApproveView(challenge: challenge)
        }
    }
}

/// The biometric app-open gate shown when paired but locked.
struct GateView: View {
    @EnvironmentObject var app: AppState
    @State private var authenticating = false
    @State private var failed = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "lock.shield")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(.tint)
            Text("Cindro is locked")
                .font(.title2.weight(.semibold))
            Text("Unlock with Face ID to continue.")
                .foregroundStyle(.secondary)
            Button {
                Task { await authenticate() }
            } label: {
                Label(failed ? "Try again" : "Unlock", systemImage: "faceid")
                    .frame(maxWidth: 220)
            }
            .buttonStyle(.borderedProminent)
            .disabled(authenticating)
            Spacer()
        }
        .padding()
        .task { await authenticate() }   // prompt immediately on appear
    }

    private func authenticate() async {
        guard !authenticating else { return }
        authenticating = true
        defer { authenticating = false }
        let ok = await Biometric.authenticate(reason: "Unlock Cindro")
        if ok { app.unlock() } else { failed = true }
    }
}
