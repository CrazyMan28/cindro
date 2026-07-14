import Foundation
import Combine

/// The single daemon gateway. Owns the long-lived [DeviceClient] and exposes the whole
/// Contract A method catalog as typed async calls, re-publishing the client's event
/// streams. Port of Android's `com.cindro.app.net.JarvisRepository`.
///
/// Tier notes (mirrors Android `tierOf`): methods marked BIOMETRIC below require the
/// **caller** (a ViewModel) to clear a Face ID / Touch ID prompt first — the repository
/// itself just makes the call, exactly like the Android layering.
@MainActor
final class JarvisRepository: ObservableObject {
    enum RepoError: LocalizedError {
        case daemon(String)
        var errorDescription: String? { if case let .daemon(m) = self { return m }; return nil }
    }

    let client: DeviceClient
    private let pairingStore: PairingStore

    init(identity: DeviceIdentity, pairingStore: PairingStore, onAuthFailure: @escaping () -> Void = {}) {
        self.pairingStore = pairingStore
        self.client = DeviceClient(identity: identity, pairingStore: pairingStore, onAuthFailure: onAuthFailure)
    }

    // MARK: connection

    func connect() {
        let raw = pairingStore.hostPort ?? PairingStore.defaultHostPort
        guard let hp = HostPort.parse(raw) else { return }
        client.connect(url: hp.wsUrl(), name: pairingStore.deviceName)
    }

    func shutdown() { client.shutdown() }

    /// Per-session brain-event stream (folded by ChatViewModel).
    func eventsFor(_ sessionId: String) -> AnyPublisher<BrainEvent, Never> {
        client.events.filter { $0.sessionId == sessionId }.map(\.event).eraseToAnyPublisher()
    }

    // MARK: low-level

    @discardableResult
    private func result(_ method: String, _ params: JSONObject = [:], timeoutMs: Int = 30_000) async throws -> JSONObject {
        let resp = try await client.request(method, params: params, timeoutMs: timeoutMs)
        guard resp.ok else { throw RepoError.daemon(resp.errorMessage ?? "‘\(method)’ failed") }
        return resp.result ?? [:]
    }

    // MARK: sessions & history

    func listSessions() async throws -> [Session] {
        let r = try await result("session.list")
        return (r.objArr("sessions") ?? []).compactMap(Session.from)
    }

    func history(_ sessionId: String, limit: Int = 200) async throws -> [BrainEvent] {
        let r = try await result("session.history", ["session_id": sessionId, "limit": limit])
        return (r.objArr("events") ?? []).map { raw in
            // events may be wrapped `{ev:{…}}`
            BrainEvent.from(raw.obj("ev") ?? raw)
        }
    }

    /// Defaults mirror Android's `createSession` (profile="coworker", brain="codex"), which
    /// always transmits both — so a new chat behaves identically to the Android app rather
    /// than falling back to whatever brain the daemon happens to default to.
    func createSession(profile: String = "coworker", brain: String = "codex", model: String? = nil) async throws -> String {
        let r = try await result("session.create", Params.of([
            "profile": profile, "brain": brain, "model": model,
        ]))
        return r.str("session_id") ?? ""
    }

    func send(_ sessionId: String, text: String, images: [PendingImage] = []) async throws {
        var params: JSONObject = ["session_id": sessionId, "text": text]
        if !images.isEmpty {
            params["images"] = images.map { ["mime": $0.mime, "b64": $0.b64] as JSONObject }
        }
        try await result("session.send", params)
    }

    func cancel(_ sessionId: String) async throws { try await result("session.cancel", ["session_id": sessionId]) }
    func delete(_ sessionId: String) async throws { try await result("session.delete", ["session_id": sessionId]) }

    // MARK: tasks / queue

    func listTasks() async throws -> [QueuedTask] {
        let r = try await result("task.list")
        return (r.objArr("tasks") ?? []).compactMap(QueuedTask.from)
    }

    func queueTask(text: String, when: String?) async throws {
        try await result("task.queue", Params.of(["text": text, "when": when]))
    }

    // MARK: trust policies (jarvis#71)

    func listPolicies() async throws -> TrustPolicies { TrustPolicies.from(try await result("policy.list")) }
    func addPolicy(tool: String, app: String, action: String, note: String?) async throws {   // BIOMETRIC
        try await result("policy.add", Params.of(["tool": tool, "app": app, "action": action, "note": note]))
    }
    func updatePolicy(id: String, action: String) async throws { try await result("policy.update", ["id": id, "action": action]) }
    func removePolicy(id: String) async throws { try await result("policy.remove", ["id": id]) }
    func setDefaultPolicy(_ action: String) async throws { try await result("policy.set_default", ["action": action]) }

    // MARK: phone policy (device-exposed capability map)

    func phonePolicyList() async throws -> JSONObject { try await result("phone.policy.list") }
    func phonePolicySet(id: String, value: Any) async throws { try await result("phone.policy.set", ["id": id, "value": value]) }
    func phonePolicyReset() async throws { try await result("phone.policy.reset") }

    // MARK: push / auth

    func registerPush(fcmToken: String) async throws { try await result("push.register", ["fcm_token": fcmToken]) }
    func respondApproval(sessionId: String, approvalId: String, decision: String) async throws {   // BIOMETRIC
        try await result("approval.respond", ["session_id": sessionId, "approval_id": approvalId, "decision": decision])
    }
    func authApprove(challengeId: String) async throws { try await result("auth.approve", ["challenge_id": challengeId]) }
    func authDeny(challengeId: String) async throws { try await result("auth.deny", ["challenge_id": challengeId]) }

    // MARK: voice (Mistral Voxtral, daemon-proxied)

    func stt(audioB64: String, mime: String, lang: String? = nil) async throws -> String {
        let r = try await result("voice.stt", Params.of(["audio_b64": audioB64, "mime": mime, "lang": lang]))
        return r.str("text") ?? ""
    }
    func tts(text: String, voice: String?, format: String = "mp3") async throws -> (audioB64: String, mime: String) {
        let r = try await result("voice.tts", Params.of(["text": text, "voice": voice, "format": format]))
        return (r.str("audio_b64") ?? "", r.str("mime") ?? "audio/mpeg")
    }
    func listVoices() async throws -> [JSONObject] { (try await result("voice.list_voices")).objArr("voices") ?? [] }
    func setDefaultVoice(_ voice: String) async throws { try await result("voice.set_default", ["voice": voice]) }
    func deleteClone(_ voice: String) async throws { try await result("voice.delete_clone", ["voice": voice]) }

    // MARK: settings / models

    func settings() async throws -> JSONObject { try await result("settings.get") }
    func setSettings(patch: JSONObject) async throws { try await result("settings.set", ["patch": patch]) }   // BIOMETRIC
    func listModels(brain: String?) async throws -> [ModelInfo] {
        let r = try await result("model.list", Params.of(["brain": brain]))
        return (r.arr("models") ?? []).compactMap(ModelInfo.from)
    }

    // MARK: MCP

    func mcpList() async throws -> [McpServer] { ((try await result("mcp.list")).objArr("servers") ?? []).compactMap(McpServer.from) }
    func mcpAdd(name: String, transport: String, endpoint: String?, token: String?, enabled: Bool, risk: String?) async throws {   // BIOMETRIC
        try await result("mcp.add", Params.of([
            "name": name, "transport": transport, "endpoint": endpoint,
            "token": token, "enabled": enabled, "risk": risk,
        ]))
    }
    func mcpRemove(_ name: String) async throws { try await result("mcp.remove", ["name": name]) }
    func mcpSetEnabled(_ name: String, _ enabled: Bool) async throws { try await result("mcp.set_enabled", ["name": name, "enabled": enabled]) }
    func mcpTest(_ name: String) async throws -> String { (try await result("mcp.test", ["name": name])).str("status") ?? "unknown" }
    func mcpCliList() async throws -> [CliMcp] {
        // Daemon returns {servers:[{brain,name,transport,enabled},…]}, each element carrying
        // its own brain — same shape Android reads. (Do NOT iterate the top-level dict.)
        let r = try await result("mcp.cli_list")
        return (r.objArr("servers") ?? []).compactMap { CliMcp.from($0.str("brain") ?? "", $0) }
    }
    func mcpCliSetEnabled(brain: String, name: String, enabled: Bool) async throws {
        try await result("mcp.cli_set_enabled", ["brain": brain, "name": name, "enabled": enabled])
    }

    // MARK: plugins

    func pluginCatalog() async throws -> [Plugin] { ((try await result("plugins.catalog")).objArr("plugins") ?? []).compactMap(Plugin.from) }
    func pluginInstall(_ id: String) async throws { try await result("plugins.install", ["id": id]) }
    func pluginSetEnabled(_ id: String, _ enabled: Bool) async throws { try await result("plugins.set_enabled", ["id": id, "enabled": enabled]) }
    func pluginRemove(_ id: String) async throws { try await result("plugins.remove", ["id": id]) }

    // MARK: memory

    func memoryList() async throws -> [MemoryEntry] { ((try await result("memory.list")).objArr("memories") ?? []).compactMap(MemoryEntry.from) }
    func memorySearch(_ q: String) async throws -> [MemoryEntry] {
        let r = try await result("memory.search", ["q": q, "include_agent_scoped": true])
        return (r.objArr("memories") ?? []).compactMap(MemoryEntry.from)
    }
    func memoryAdd(text: String, tags: [String]) async throws { try await result("memory.add", ["text": text, "tags": tags]) }
    func memoryRemove(_ id: String) async throws { try await result("memory.remove", ["id": id]) }

    // MARK: skills

    func skillsList() async throws -> [Skill] { ((try await result("skills.list")).objArr("skills") ?? []).compactMap(Skill.from) }
    func skillGet(_ name: String) async throws -> JSONObject { try await result("skills.get", ["name": name]) }
    func skillCreate(name: String, description: String, body: String) async throws {
        try await result("skills.create", ["name": name, "description": description, "body": body])
    }
    /// Returns the rendered directive `message` (Claude-Code-style injected skill body).
    func skillInvoke(name: String, args: String?, sessionId: String?) async throws -> String {
        let r = try await result("skills.invoke", Params.of(["name": name, "args": args, "session_id": sessionId]))
        return r.str("message") ?? ""
    }
    func skillRemove(_ name: String) async throws { try await result("skills.remove", ["name": name]) }
    func skillPin(_ name: String, _ pinned: Bool) async throws { try await result("skills.pin", ["name": name, "pinned": pinned]) }
    func skillsToday() async throws -> [TodayItem] {
        let r = try await result("skills.today")
        let digest = r.str("digest") ?? ""
        // Flatten the markdown digest into simple line items (one per non-blank line).
        return digest.split(separator: "\n").map { line in
            TodayItem(title: line.trimmingCharacters(in: CharacterSet(charactersIn: "-* ")), detail: nil)
        }
    }

    // MARK: agents

    func agentsList() async throws -> [Agent] { ((try await result("agents.list")).objArr("agents") ?? []).compactMap(Agent.from) }
    func agentGet(_ name: String) async throws -> JSONObject { try await result("agents.get", ["name": name]) }
    func agentCreate(name: String, description: String, whenToUse: String, systemPrompt: String,
                     brain: String?, model: String?, profile: String?) async throws {
        try await result("agents.create", Params.of([
            "name": name, "description": description, "when_to_use": whenToUse,
            "system_prompt": systemPrompt, "brain": brain, "model": model, "profile": profile,
        ]))
    }
    func agentRemove(_ name: String) async throws { try await result("agents.remove", ["name": name]) }
    /// Dispatch a subagent; returns the child session id.
    func agentDispatch(agent: String, task: String, parentSessionId: String?) async throws -> String {
        let r = try await result("agents.dispatch", Params.of([
            "agent": agent, "task": task, "parent_session_id": parentSessionId,
        ]))
        return r.str("session_id") ?? ""
    }

    // MARK: computer / mirror

    func mirrorStart(_ sessionId: String) async throws -> (width: Int, height: Int) {   // BIOMETRIC
        let r = try await result("mirror.start", ["session_id": sessionId])
        return (r.int("width") ?? 0, r.int("height") ?? 0)
    }
    func mirrorStop(_ sessionId: String) async throws { try await result("mirror.stop", ["session_id": sessionId]) }
    func inputEvent(sessionId: String, kind: String, x: Int? = nil, y: Int? = nil, button: String? = nil, dy: Int? = nil) async throws {
        try await result("input.event", Params.of([
            "session_id": sessionId, "kind": kind, "x": x, "y": y, "button": button, "dy": dy,
        ]))
    }
    func takeOverRequest(_ sessionId: String) async throws { try await result("take_over.request", ["session_id": sessionId]) }   // BIOMETRIC

    // MARK: phone subsystem proxy

    func phoneMcp(name: String, arguments: JSONObject) async throws -> JSONObject {
        try await result("phone.mcp", ["name": name, "arguments": arguments])
    }
    func phoneHttp(method: String, path: String, body: JSONObject?) async throws -> JSONObject {
        try await result("phone.http", Params.of(["method": method, "path": path, "body": body]))
    }

    // MARK: live widgets / files

    func widgetViewing(scope: String, kind: String, active: Bool) async throws { try await result("widget.viewing", ["scope": scope, "kind": kind, "active": active]) }
    func widgetPin(id: String, active: Bool) async throws { try await result("widget.pin", ["id": id, "active": active]) }
    func widgetUnpin(id: String) async throws { try await result("widget.unpin", ["id": id]) }
    func filePush(name: String, b64: String, sessionId: String?) async throws {
        try await result("file.push", Params.of(["name": name, "b64": b64, "session_id": sessionId]))
    }
}
