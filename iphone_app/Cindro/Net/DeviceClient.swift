import Foundation
import Combine

/// Long-lived Contract C device WebSocket client (`ws://<host>:<port>/device/ws`).
///
/// Port of Android's `com.cindro.app.net.DeviceClient`. Lifecycle per connection:
///  1. Open the socket.
///  2. **Handshake** — for an already-paired device we send
///     `{"hello":true,"device_pubkey":<b64>,"name":<str>}`; the daemon replies
///     `{"challenge":<nonce-b64>}`; we sign the raw nonce bytes and send `{"sig":<b64>}`;
///     the daemon acks `{"authed":true,"fp":<fingerprint>}`. (Pairing — the `pair_code`
///     path — is handled separately by [PairingClient] before this client ever runs.)
///  3. **Authed envelope phase** — Contract A request/response + session.event frames.
///
/// Requests are correlated by a monotonically increasing `id`; [request] suspends until
/// the matching response (or times out). Unsolicited events are re-published on Combine
/// subjects. The socket auto-reconnects with jittered backoff while `shouldRun`.
final class DeviceClient: NSObject, ObservableObject {
    enum State { case disconnected, connecting, handshaking, connected, error }

    enum ClientError: LocalizedError {
        case notConnected, notAuthenticated, sendFailed, timeout(String)
        var errorDescription: String? {
            switch self {
            case .notConnected: return "not connected"
            case .notAuthenticated: return "device not authenticated"
            case .sendFailed: return "send failed (socket closing)"
            case .timeout(let m): return "request '\(m)' timed out"
            }
        }
    }

    // MARK: Published UI state (main-thread)
    @Published private(set) var state: State = .disconnected
    @Published private(set) var lastError: String?
    /// Soft, dismissible warning when a reconnect ack's daemon fingerprint (`fp`) doesn't
    /// match the one pinned at pairing time. Advisory only — never hard-blocks (anti-brick
    /// on a legit reinstall / key rotation).
    @Published var identityWarning: String?

    // MARK: Event streams
    let events = PassthroughSubject<SessionEvent, Never>()
    let sessionOpened = PassthroughSubject<SessionOpened, Never>()
    let fileOffers = PassthroughSubject<FileOffer, Never>()
    let widgetEvents = PassthroughSubject<WidgetEvent, Never>()
    let authChallenges = PassthroughSubject<AuthChallenge, Never>()
    let frames = PassthroughSubject<MirrorFrame, Never>()

    // MARK: Deps
    private let identity: DeviceIdentity
    private let pairingStore: PairingStore?
    /// Invoked when the daemon rejects this device (unknown/removed key) — the app clears
    /// pairing. Settable post-init so `AppState` can wire itself in.
    var onAuthFailure: () -> Void

    // MARK: Socket + sync
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private let lock = NSRecursiveLock()
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<WsResponse, Error>] = [:]
    private var authWaiters: [Int: CheckedContinuation<Void, Error>] = [:]
    private var waiterSeq = 0

    private var authed = false
    private var shouldRun = false
    private var wsUrl: String?
    private var deviceName = "iPhone"
    private var reconnectAttempts = 0

    init(identity: DeviceIdentity,
         pairingStore: PairingStore? = nil,
         onAuthFailure: @escaping () -> Void = {}) {
        self.identity = identity
        self.pairingStore = pairingStore
        self.onAuthFailure = onAuthFailure
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 0            // streaming socket
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    // MARK: Public API

    /// Start (or retarget) the connection. Safe to call repeatedly.
    func connect(url: String, name: String) {
        lock.lock()
        wsUrl = url
        deviceName = name
        shouldRun = true
        let noSocket = task == nil
        lock.unlock()
        if noSocket { openSocket() }
    }

    /// Permanently stop reconnecting and close the socket.
    func shutdown() {
        lock.lock()
        shouldRun = false
        authed = false
        let t = task
        task = nil
        lock.unlock()
        t?.cancel(with: .normalClosure, reason: nil)
        failAllPending(reason: "client shutdown")
        setState(.disconnected)
    }

    func dismissIdentityWarning() { DispatchQueue.main.async { self.identityWarning = nil } }

    /// Send an authed Contract A request and await the response. Waits for the handshake
    /// to finish first (up to `authTimeoutMs`).
    func request(_ method: String,
                 params: JSONObject = [:],
                 timeoutMs: Int = 30_000,
                 authTimeoutMs: Int = 15_000) async throws -> WsResponse {
        try await awaitAuth(timeoutMs: authTimeoutMs)

        lock.lock()
        guard let t = task else { lock.unlock(); throw ClientError.notConnected }
        let id = nextId; nextId += 1
        lock.unlock()

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<WsResponse, Error>) in
            lock.lock()
            pending[id] = cont
            lock.unlock()

            t.send(.string(WireProtocol.request(id: id, method: method, params: params))) { [weak self] err in
                if err != nil { self?.resolve(id: id, with: .failure(ClientError.sendFailed)) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
                self?.resolve(id: id, with: .failure(ClientError.timeout(method)))
            }
        }
    }

    // MARK: Auth gate

    private func awaitAuth(timeoutMs: Int) async throws {
        lock.lock()
        if authed { lock.unlock(); return }
        if !shouldRun, let url = wsUrl {
            let name = deviceName
            lock.unlock()
            connect(url: url, name: name)
            lock.lock()
        }
        lock.unlock()

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.lock()
            if authed { lock.unlock(); cont.resume(); return }
            let token = waiterSeq; waiterSeq += 1
            authWaiters[token] = cont
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let c = self.authWaiters.removeValue(forKey: token)
                self.lock.unlock()
                c?.resume(throwing: ClientError.notAuthenticated)
            }
        }
    }

    private func resumeWaiters(success: Bool) {
        lock.lock()
        let waiters = authWaiters
        authWaiters.removeAll()
        lock.unlock()
        for (_, c) in waiters {
            if success { c.resume() } else { c.resume(throwing: ClientError.notAuthenticated) }
        }
    }

    // MARK: Socket lifecycle

    private func openSocket() {
        lock.lock()
        guard let urlStr = wsUrl, let url = URL(string: urlStr) else { lock.unlock(); return }
        authed = false
        let t = session.webSocketTask(with: url)
        task = t
        lock.unlock()
        setState(.connecting)
        t.resume()
        receive(on: t)
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                self.onDown(reason: err.localizedDescription, retry: true)
            case .success(let message):
                switch message {
                case .string(let text): self.handleText(text)
                case .data(let data): self.handleBinary(data)
                @unknown default: break
                }
                // Keep reading only if this is still the live socket.
                self.lock.lock(); let live = (self.task === t); self.lock.unlock()
                if live { self.receive(on: t) }
            }
        }
    }

    private func handleText(_ text: String) {
        guard let obj = WireProtocol.parse(text) else { return }

        lock.lock(); let isAuthed = authed; lock.unlock()
        if !isAuthed {
            handleHandshake(obj)
            return
        }

        // --- authed envelope phase ---
        if let ev = SessionEvent.from(obj) { publish { self.events.send(ev) }; return }
        if let fo = FileOffer.event(obj) { publish { self.fileOffers.send(fo) }; return }
        if let w = WidgetEvent.from(obj) { publish { self.widgetEvents.send(w) }; return }
        if let so = SessionOpened.event(obj) { publish { self.sessionOpened.send(so) }; return }
        if let ac = AuthChallenge.from(obj) { publish { self.authChallenges.send(ac) }; return }
        if let resp = WsResponse.from(obj) { resolve(id: resp.id, with: .success(resp)); return }
    }

    private func handleHandshake(_ obj: JSONObject) {
        // {"challenge":<nonce-b64>} → sign the raw nonce bytes.
        if let challenge = obj.str("challenge"), let nonce = Data(base64Encoded: challenge) {
            lock.lock(); let t = task; lock.unlock()
            t?.send(.string(WireProtocol.encode(["sig": identity.sign(nonce)]))) { _ in }
            return
        }
        // A malformed non-string challenge: drop it, keep handshaking.
        if obj["challenge"] != nil { return }

        if obj["authed"] != nil || obj.str("event") == "authed" {
            let ok = obj.bool("authed") ?? true
            if ok {
                checkIdentityFingerprint(obj)
                lock.lock(); authed = true; reconnectAttempts = 0; lock.unlock()
                setState(.connected)
                DispatchQueue.main.async { self.lastError = nil }
                resumeWaiters(success: true)
            } else {
                handleAuthRejected("daemon rejected device")
            }
            return
        }
        if let err = obj.obj("error") {
            handleAuthRejected(err.str("message") ?? "handshake error")
        }
        // else: unrecognized pre-auth frame — drop it.
    }

    private func handleBinary(_ data: Data) {
        if let frame = MirrorFrame.parse(data) { publish { self.frames.send(frame) } }
    }

    /// Compare the reconnect ack's daemon fingerprint against the pinned one. Fail OPEN
    /// when nothing is pinned or the daemon didn't send one; on mismatch, a soft warning.
    private func checkIdentityFingerprint(_ obj: JSONObject) {
        guard let fp = obj.str("fp") else { return }
        guard let pinned = pairingStore?.daemonFingerprint, !pinned.isEmpty else { return }
        let warning = fp != pinned
            ? "This device's paired computer identity looks different from when you paired. "
              + "If you didn't reinstall or re-pair Cindro, consider re-pairing to be safe."
            : nil
        DispatchQueue.main.async { self.identityWarning = warning }
    }

    private func handleAuthRejected(_ msg: String) {
        lock.lock()
        authed = false
        shouldRun = false
        let t = task
        task = nil
        lock.unlock()
        DispatchQueue.main.async { self.lastError = msg }
        setState(.error)
        resumeWaiters(success: false)
        t?.cancel(with: .normalClosure, reason: nil)
        onAuthFailure()
    }

    private func onDown(reason: String, retry: Bool) {
        lock.lock()
        let wasAuthed = authed
        authed = false
        task = nil
        let run = shouldRun
        lock.unlock()

        resumeWaiters(success: false)
        failAllPending(reason: reason)

        if run && retry {
            setState(.connecting)
            scheduleReconnect()
        } else {
            setState(wasAuthed ? .disconnected : .error)
            DispatchQueue.main.async { self.lastError = reason }
        }
    }

    private func scheduleReconnect() {
        lock.lock()
        reconnectAttempts += 1
        let attempt = min(reconnectAttempts, 5)
        lock.unlock()
        let base = min(500 * (1 << attempt), 15_000)
        let jitter = Int.random(in: 0...400)
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(base + jitter)) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let go = self.shouldRun && self.task == nil; self.lock.unlock()
            if go { self.openSocket() }
        }
    }

    // MARK: helpers

    private func resolve(id: Int, with result: Swift.Result<WsResponse, Error>) {
        lock.lock(); let cont = pending.removeValue(forKey: id); lock.unlock()
        guard let cont else { return }
        switch result {
        case .success(let r): cont.resume(returning: r)
        case .failure(let e): cont.resume(throwing: e)
        }
    }

    private func failAllPending(reason: String) {
        lock.lock(); let snapshot = pending; pending.removeAll(); lock.unlock()
        for (_, cont) in snapshot { cont.resume(throwing: ClientError.notConnected) }
    }

    private func setState(_ s: State) { DispatchQueue.main.async { self.state = s } }
    private func publish(_ block: @escaping () -> Void) { DispatchQueue.main.async(execute: block) }
}

extension DeviceClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        // Step 2 (handshake): send hello for an already-paired device.
        setState(.handshaking)
        let hello: JSONObject = [
            "hello": true,
            "device_pubkey": identity.publicKeyB64,
            "name": deviceName,
        ]
        webSocketTask.send(.string(WireProtocol.encode(hello))) { _ in }
    }
}
