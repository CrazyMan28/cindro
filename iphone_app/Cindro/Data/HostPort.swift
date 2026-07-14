import Foundation

/// A `host:port` pair for the daemon device channel, with the ws URL builder.
/// Port of Android's `com.cindro.app.data.HostPort`.
struct HostPort {
    let host: String
    let port: Int

    func wsUrl(path: String = "/device/ws") -> String { "ws://\(host):\(port)\(path)" }

    /// Parse "host:port" (IPv4 / hostname). Falls back to the default port when omitted.
    static func parse(_ raw: String, defaultPort: Int = 8796) -> HostPort? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        // rsplit on the last ':' so IPv6 (not used here, but safe) doesn't mangle.
        if let idx = trimmed.lastIndex(of: ":") {
            let host = String(trimmed[trimmed.startIndex..<idx])
            let portStr = String(trimmed[trimmed.index(after: idx)...])
            guard !host.isEmpty, let port = Int(portStr), (1...65535).contains(port) else { return nil }
            return HostPort(host: host, port: port)
        }
        return HostPort(host: trimmed, port: defaultPort)
    }
}
