import Foundation

/// One-shot Contract C pairing handshake. Opens `/device/ws`, sends the `hello` frame
/// with the device public key, name **and** the one-time `pair_code` from the scanned QR
/// (or manual entry). The daemon stores the pubkey in devices.json and acks paired.
///
/// Distinct from [DeviceClient] (the challenge/sign reconnect handshake for an
/// already-paired device); this runs exactly once, returns, and closes the socket.
/// Port of Android's `com.cindro.app.net.PairingClient`.
final class PairingClient: NSObject {
    enum Result {
        /// `fingerprint` is the daemon's identity fingerprint from the ack's `fp` field
        /// (nil on older daemons or the bare-`authed` fallback path).
        case paired(deviceId: String, fingerprint: String?)
        case failed(reason: String)
    }

    private let identity: DeviceIdentity
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var deviceName = ""
    private var pairCode = ""
    private var continuation: CheckedContinuation<Result, Never>?
    private var finished = false
    private let lock = NSLock()

    init(identity: DeviceIdentity) {
        self.identity = identity
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    func pair(wsUrl: String, code: String, deviceName: String, timeoutMs: Int = 20_000) async -> Result {
        guard let url = URL(string: wsUrl) else { return .failed(reason: "invalid daemon address") }
        self.deviceName = deviceName
        self.pairCode = code

        return await withCheckedContinuation { (cont: CheckedContinuation<Result, Never>) in
            self.continuation = cont
            let task = session.webSocketTask(with: url)
            self.task = task
            task.resume()
            // The delegate's didOpen sends `hello`; drive the receive loop here.
            receive()
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
                self?.finish(.failed(reason: "pairing timed out — is the code still showing on the desktop?"))
            }
        }
    }

    private func sendHello() {
        let hello: JSONObject = [
            "hello": true,
            "device_pubkey": identity.publicKeyB64,
            "name": deviceName,
            "pair_code": pairCode,
        ]
        task?.send(.string(WireProtocol.encode(hello))) { _ in }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                self.finish(.failed(reason: err.localizedDescription))
            case .success(let message):
                if case let .string(text) = message { self.handle(text) }
                if !self.isFinished { self.receive() }
            }
        }
    }

    private func handle(_ text: String) {
        guard let obj = WireProtocol.parse(text) else { return }
        if let challenge = obj.str("challenge"), let nonce = Data(base64Encoded: challenge) {
            // Some daemons issue a challenge even on the pair path (defense in depth).
            task?.send(.string(WireProtocol.encode(["sig": identity.sign(nonce)]))) { _ in }
            return
        }
        if obj["paired"] != nil || obj.str("event") == "paired" {
            let ok = obj.bool("paired") ?? true
            if ok {
                let id = obj.str("device_id") ?? identity.fingerprint
                finish(.paired(deviceId: id, fingerprint: obj.str("fp")))
            } else {
                finish(.failed(reason: "daemon refused pairing"))
            }
            return
        }
        if obj["authed"] != nil {
            finish(.paired(deviceId: identity.fingerprint, fingerprint: nil))
            return
        }
        if let err = obj.obj("error") {
            finish(.failed(reason: err.str("message") ?? "pairing error"))
        }
    }

    private var isFinished: Bool {
        lock.lock(); defer { lock.unlock() }
        return finished
    }

    private func finish(_ result: Result) {
        lock.lock()
        if finished { lock.unlock(); return }
        finished = true
        let cont = continuation
        continuation = nil
        lock.unlock()

        task?.cancel(with: .normalClosure, reason: nil)
        cont?.resume(returning: result)
    }
}

extension PairingClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        sendHello()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(.failed(reason: "connection closed before pairing"))
    }
}
