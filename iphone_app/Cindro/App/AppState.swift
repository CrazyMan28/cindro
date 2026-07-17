import Foundation
import Combine
import SwiftUI

/// Process-wide singletons + top-level app state. The iOS analogue of Android's
/// `JarvisApp` (which holds `secretStore`, `pairingStore`, `identity`, `repository`, …).
///
/// Owns:
///  - the [Keychain] + Ed25519 [DeviceIdentity] (minted on first launch),
///  - the [PairingStore] (host:port / paired / fingerprint / device name),
///  - the one [JarvisRepository] (which owns the long-lived device socket),
///  - the biometric app-open gate flag and cross-device unlock challenge.
@MainActor
final class AppState: ObservableObject {
    let keychain = Keychain()
    let pairingStore = PairingStore()
    let identity: DeviceIdentity
    let repository: JarvisRepository
    let fileReceiver: FileReceiver
    let widgetStore: WidgetStore

    /// Whether the phone is paired to a daemon (start destination = pairing when false).
    @Published var isPaired: Bool
    /// Biometric app-open gate. Resets to locked on cold launch (matches Android's
    /// `appUnlocked` being a plain `remember`).
    @Published var appUnlocked = false
    /// Whether the biometric app-open gate is enabled at all (Settings toggle, default on).
    @Published var gateEnabled: Bool
    /// A pending cross-device unlock challenge (desktop/extension sign-in) to approve.
    @Published var pendingChallenge: AuthChallenge?
    /// A session id pushed by `session.opened` for the shell to deep-link into.
    @Published var openSessionId: String?

    private var cancellables = Set<AnyCancellable>()

    init() {
        let keychain = self.keychain
        let pairingStore = self.pairingStore
        identity = DeviceIdentity.loadOrCreate(keychain)
        repository = JarvisRepository(identity: identity, pairingStore: pairingStore)
        fileReceiver = FileReceiver(offers: repository.client.fileOffers)
        widgetStore = WidgetStore(events: repository.client.widgetEvents)
        isPaired = pairingStore.isPaired
        gateEnabled = UserDefaults.standard.object(forKey: "fingerprint_gate") as? Bool ?? true

        repository.client.onAuthFailure = { [weak self] in
            Task { @MainActor in self?.handleAuthFailure() }
        }

        // Re-publish daemon-pushed events into app-level state.
        repository.client.authChallenges
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.pendingChallenge = $0 }
            .store(in: &cancellables)
        repository.client.sessionOpened
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.openSessionId = $0.sessionId }
            .store(in: &cancellables)

        // Skip auto-connect when the identity is ephemeral (the Keychain couldn't be read
        // this launch): the daemon can't know this throwaway key, so connecting would only
        // draw an auth-reject that force-unpairs us. The real seed survives for the next
        // readable launch, which will connect normally.
        if isPaired && !identity.isEphemeral { repository.connect() }
    }

    /// Called by the pairing flow once the daemon acks a successful pair.
    func onPaired() {
        isPaired = true
        appUnlocked = true            // the user just interacted; don't immediately re-gate
        repository.connect()
    }

    func unlock() { appUnlocked = true }

    func setGateEnabled(_ on: Bool) {
        gateEnabled = on
        UserDefaults.standard.set(on, forKey: "fingerprint_gate")
    }

    func unpair() {
        pairingStore.clearPairing()
        repository.shutdown()
        isPaired = false
        appUnlocked = false
    }

    private func handleAuthFailure() {
        // An ephemeral identity (Keychain unreadable this launch) draws an expected reject
        // for a key the daemon never saw — that must NOT wipe the still-valid stored
        // pairing. Only a genuine reject of our real, persisted key means deregistration.
        guard !identity.isEphemeral else { return }
        // The daemon no longer recognises this device's key — force re-pairing.
        pairingStore.clearPairing()
        isPaired = false
        appUnlocked = false
    }
}
