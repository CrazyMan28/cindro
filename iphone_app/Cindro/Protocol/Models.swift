import Foundation

/// Permission tier for a daemon method. BIOMETRIC-tier calls require the caller to clear
/// a Face ID / Touch ID prompt first. Mirrors Android `protocol/Models.kt` `Tier`.
enum Tier { case read, action, biometric }

/// A chat session row. Subagents (non-blank `parentSessionId`) are filtered out of
/// top-level lists on every surface.
struct Session: Identifiable, Equatable {
    let id: String
    let title: String?
    let profile: String?
    let brain: String?
    let state: String?
    let updatedAt: Double?
    let parentSessionId: String?
    let agent: String?
    let model: String?

    var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? "New chat" }
    var isSubagent: Bool { (parentSessionId?.isEmpty == false) }

    static func from(_ o: JSONObject) -> Session? {
        guard let id = o.str("id") ?? o.str("session_id") else { return nil }
        return Session(
            id: id,
            title: o.str("title"),
            profile: o.str("profile"),
            brain: o.str("brain"),
            state: o.str("state"),
            updatedAt: o.dbl("updated_at"),
            parentSessionId: o.str("parent_session_id"),
            agent: o.str("agent"),
            model: o.str("model")
        )
    }
}

struct TrustRule: Identifiable {
    let id: String
    let tool: String
    let app: String
    let action: String   // allow | ask | deny
    let note: String?

    static func from(_ o: JSONObject) -> TrustRule? {
        guard let id = o.str("id") else { return nil }
        return TrustRule(id: id, tool: o.str("tool") ?? "*", app: o.str("app") ?? "*",
                         action: o.str("action") ?? "allow", note: o.str("note"))
    }
}

struct TrustPolicies {
    let defaultAction: String
    let rules: [TrustRule]

    static func from(_ o: JSONObject) -> TrustPolicies {
        TrustPolicies(defaultAction: o.str("default") ?? "allow",
                      rules: (o.objArr("rules") ?? []).compactMap(TrustRule.from))
    }
}

struct QueuedTask: Identifiable {
    let id: String
    let text: String
    let state: String?
    let whenAt: String?

    static func from(_ o: JSONObject) -> QueuedTask? {
        guard let id = o.str("id") else { return nil }
        return QueuedTask(id: id, text: o.str("text") ?? "", state: o.str("state"),
                          whenAt: o.str("when") ?? o.str("when_at"))
    }
}

struct PairedDevice: Identifiable {
    let id: String
    let name: String?
    let pairedAt: String?
    let lastSeen: String?

    static func from(_ o: JSONObject) -> PairedDevice? {
        guard let id = o.str("id") else { return nil }
        return PairedDevice(id: id, name: o.str("name"),
                            pairedAt: o.str("paired_at"), lastSeen: o.str("last_seen"))
    }
}

struct ModelInfo: Identifiable {
    let id: String
    let label: String?
    let brain: String?

    var display: String { (label?.isEmpty == false ? label! : id) }

    /// `model.list` tolerates a flat string array OR objects.
    static func from(_ any: Any) -> ModelInfo? {
        if let s = any as? String { return ModelInfo(id: s, label: nil, brain: nil) }
        if let o = any as? JSONObject, let id = o.str("id") ?? o.str("name") {
            return ModelInfo(id: id, label: o.str("label") ?? o.str("display"), brain: o.str("brain"))
        }
        return nil
    }
}

struct McpServer: Identifiable {
    var id: String { name }
    let name: String
    let url: String?
    let command: String?
    let enabled: Bool
    let status: String?

    static func from(_ o: JSONObject) -> McpServer? {
        guard let name = o.str("name") else { return nil }
        return McpServer(name: name, url: o.str("url") ?? o.str("endpoint"),
                         command: o.str("command"), enabled: o.bool("enabled") ?? true,
                         status: o.str("status"))
    }
}

struct CliMcp: Identifiable {
    var id: String { "\(brain)/\(name)" }
    let brain: String
    let name: String
    let transport: String?
    let enabled: Bool

    static func from(_ brain: String, _ o: JSONObject) -> CliMcp? {
        guard let name = o.str("name") else { return nil }
        return CliMcp(brain: brain, name: name, transport: o.str("transport"),
                      enabled: o.bool("enabled") ?? false)
    }
}

struct Plugin: Identifiable {
    let id: String
    let name: String?
    let description: String?
    let version: String?
    let installed: Bool
    let enabled: Bool

    static func from(_ o: JSONObject) -> Plugin? {
        guard let id = o.str("id") ?? o.str("name") else { return nil }
        return Plugin(id: id, name: o.str("name"), description: o.str("description"),
                      version: o.str("version"), installed: o.bool("installed") ?? false,
                      enabled: o.bool("enabled") ?? false)
    }
}

struct MemoryEntry: Identifiable {
    let id: String
    let content: String
    let target: String?
    let createdAt: String?

    static func from(_ o: JSONObject) -> MemoryEntry? {
        guard let id = o.str("id") else { return nil }
        return MemoryEntry(id: id, content: o.str("content") ?? o.str("text") ?? "",
                           target: o.str("target"), createdAt: o.str("created_at"))
    }
}

struct Skill: Identifiable {
    var id: String { name }
    let name: String
    let group: String?
    let description: String?
    let tags: [String]
    let body: String?
    let pinned: Bool
    let useCount: Int

    static func from(_ o: JSONObject) -> Skill? {
        guard let name = o.str("name") else { return nil }
        return Skill(name: name, group: o.str("group"), description: o.str("description"),
                     tags: (o.arr("tags") ?? []).compactMap { $0 as? String },
                     body: o.str("body"), pinned: o.bool("pinned") ?? false,
                     useCount: o.int("use_count") ?? 0)
    }
}

struct Agent: Identifiable {
    var id: String { name }
    let name: String
    let description: String?
    let whenToUse: String?
    let brain: String?
    let model: String?
    let profile: String?
    let color: String?
    let systemPrompt: String?

    static func from(_ o: JSONObject) -> Agent? {
        guard let name = o.str("name") else { return nil }
        return Agent(name: name, description: o.str("description"),
                     whenToUse: o.str("when_to_use"), brain: o.str("brain"),
                     model: o.str("model"), profile: o.str("profile"),
                     color: o.str("color"), systemPrompt: o.str("system_prompt"))
    }
}

struct TodayItem: Identifiable {
    var id: String { title }
    let title: String
    let detail: String?
}

/// A scanned pairing payload: `jarvis://pair?host=<ip:8796>&code=<code>&fp=<fingerprint>`.
struct PairPayload {
    let hostPort: String
    let code: String
    let fingerprint: String?

    static func parse(_ raw: String) -> PairPayload? {
        guard let comps = URLComponents(string: raw),
              comps.scheme == "jarvis", comps.host == "pair" else { return nil }
        let items = comps.queryItems ?? []
        func q(_ k: String) -> String? { items.first { $0.name == k }?.value }
        guard let host = q("host"), let code = q("code"), !host.isEmpty, !code.isEmpty else { return nil }
        return PairPayload(hostPort: host, code: code, fingerprint: q("fp"))
    }
}
