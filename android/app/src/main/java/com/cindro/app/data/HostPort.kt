package com.cindro.app.data

/**
 * Parsed `host:port` endpoint. Accepts bare IPv4/hostnames and bracketed IPv6
 * (e.g. `[fe80::1]:8796`). Used to validate the pairing field before connecting.
 */
data class HostPort(val host: String, val port: Int) {

    fun wsUrl(path: String = "/device/ws"): String = "ws://$host:$port$path"

    override fun toString(): String =
        if (host.contains(':')) "[$host]:$port" else "$host:$port"

    companion object {
        private val PORT_RANGE = 1..65535

        /** Returns a parsed [HostPort] or null if [raw] is not a valid `host:port`. */
        fun parse(raw: String): HostPort? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null

            val host: String
            val portStr: String
            if (trimmed.startsWith("[")) {
                // Bracketed IPv6 literal: [::1]:8796
                val close = trimmed.indexOf(']')
                if (close < 0) return null
                host = trimmed.substring(1, close)
                val rest = trimmed.substring(close + 1)
                if (!rest.startsWith(":")) return null
                portStr = rest.substring(1)
            } else {
                val colon = trimmed.lastIndexOf(':')
                if (colon <= 0 || colon == trimmed.length - 1) return null
                host = trimmed.substring(0, colon)
                portStr = trimmed.substring(colon + 1)
            }

            if (host.isBlank()) return null
            val port = portStr.toIntOrNull() ?: return null
            if (port !in PORT_RANGE) return null
            return HostPort(host, port)
        }
    }
}
