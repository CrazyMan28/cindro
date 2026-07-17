package com.cindro.app.protocol

import android.net.Uri
import com.google.gson.JsonObject
import java.nio.ByteBuffer

/**
 * Capability tier a method requires (Contract C). The daemon tags each method; the
 * phone gates [BIOMETRIC]-tier actions behind a device BiometricPrompt.
 */
enum class Tier { READ, ACTION, BIOMETRIC }

/** A session row from session.list / session.create. */
data class Session(
    val id: String,
    val title: String?,
    val profile: String?,
    val brain: String?,
    val state: String?,
    val updatedAt: Long?,
    /** Non-null/blank = this is a subagent CHILD session of that parent chat. */
    val parentSessionId: String? = null,
    /** The custom-agent name a child session runs as (when it is a subagent). */
    val agent: String? = null,
    /** The model this session runs (api-brain vision gating needs this — see VisionSupport). */
    val model: String? = null,
) {
    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: listOfNotNull(profile, brain).joinToString(" · ").ifBlank { id.take(8) }

    val isSubagent: Boolean get() = !parentSessionId.isNullOrBlank()

    companion object {
        fun from(o: JsonObject): Session = Session(
            id = o.get("id")?.asString ?: o.get("session_id")?.asString.orEmpty(),
            title = o.get("title")?.takeIf { !it.isJsonNull }?.asString,
            profile = o.get("profile")?.takeIf { !it.isJsonNull }?.asString,
            brain = o.get("brain")?.takeIf { !it.isJsonNull }?.asString,
            state = o.get("state")?.takeIf { !it.isJsonNull }?.asString,
            updatedAt = o.get("updated_at")?.takeIf { !it.isJsonNull }?.asLong
                ?: o.get("updatedAt")?.takeIf { !it.isJsonNull }?.asLong,
            parentSessionId = o.get("parent_session_id")?.takeIf { !it.isJsonNull }?.asString,
            agent = o.get("agent")?.takeIf { !it.isJsonNull }?.asString,
            model = o.get("model")?.takeIf { !it.isJsonNull }?.asString,
        )
    }
}

/** One trust-policy rule (jarvis#71): per-tool/per-app allow|ask|deny guardrail. */
data class TrustRule(
    val id: String,
    val tool: String,
    val app: String,
    val action: String,
    val note: String?,
) {
    companion object {
        fun from(o: JsonObject): TrustRule = TrustRule(
            id = o.get("id")?.asString.orEmpty(),
            tool = o.get("tool")?.takeIf { !it.isJsonNull }?.asString ?: "*",
            app = o.get("app")?.takeIf { !it.isJsonNull }?.asString ?: "*",
            action = o.get("action")?.takeIf { !it.isJsonNull }?.asString ?: "allow",
            note = o.get("note")?.takeIf { !it.isJsonNull }?.asString,
        )
    }
}

/** A queued task from task.list. */
data class QueuedTask(
    val id: String,
    val text: String,
    val state: String?,
    val whenAt: Long?,
) {
    companion object {
        fun from(o: JsonObject): QueuedTask = QueuedTask(
            id = o.get("id")?.asString.orEmpty(),
            text = o.get("text")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            state = o.get("state")?.takeIf { !it.isJsonNull }?.asString,
            whenAt = o.get("when")?.takeIf { !it.isJsonNull }?.asLong
                ?: o.get("when_at")?.takeIf { !it.isJsonNull }?.asLong,
        )
    }
}

/** A paired-device summary surfaced in Settings (from devices.list, if exposed). */
data class PairedDevice(
    val id: String,
    val name: String?,
    val pairedAt: Long?,
    val lastSeen: Long?,
)

/**
 * A decoded Contract C binary video frame:
 *   [4-byte big-endian header length][header JSON utf8][JPEG bytes]
 * The header carries {t:"mirror.frame", session_id, ts, len}.
 */
data class MirrorFrame(
    val sessionId: String,
    val ts: Long,
    val jpeg: ByteArray,
) {
    companion object {
        fun parse(bytes: ByteArray): MirrorFrame? {
            if (bytes.size < 4) return null
            val hlen = ByteBuffer.wrap(bytes, 0, 4).int
            if (hlen <= 0 || 4 + hlen > bytes.size) return null
            val header = runCatching {
                com.google.gson.JsonParser
                    .parseString(String(bytes, 4, hlen, Charsets.UTF_8))
                    .asJsonObject
            }.getOrNull() ?: return null
            if (header.get("t")?.takeIf { it.isJsonPrimitive }?.asString != "mirror.frame") return null
            val jpeg = bytes.copyOfRange(4 + hlen, bytes.size)
            if (jpeg.isEmpty()) return null
            return MirrorFrame(
                sessionId = header.get("session_id")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
                ts = header.get("ts")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
                jpeg = jpeg,
            )
        }
    }
}

/** A model id offered for a brain (from model.list). */
data class ModelInfo(val id: String, val label: String?, val brain: String?) {
    val display: String get() = label?.takeIf { it.isNotBlank() } ?: id

    companion object {
        fun from(o: JsonObject): ModelInfo = ModelInfo(
            id = o.get("id")?.asString ?: o.get("model")?.asString.orEmpty(),
            label = o.get("label")?.takeIf { !it.isJsonNull }?.asString
                ?: o.get("name")?.takeIf { !it.isJsonNull }?.asString,
            brain = o.get("brain")?.takeIf { !it.isJsonNull }?.asString,
        )
    }
}

/** An MCP server entry (from mcp.list). */
data class McpServer(
    val name: String,
    val url: String?,
    val command: String?,
    val enabled: Boolean,
    val status: String?,
) {
    companion object {
        fun from(o: JsonObject): McpServer = McpServer(
            name = o.get("name")?.asString.orEmpty(),
            url = o.get("url")?.takeIf { !it.isJsonNull }?.asString,
            command = o.get("command")?.takeIf { !it.isJsonNull }?.asString,
            enabled = o.get("enabled")?.takeIf { !it.isJsonNull }?.asBoolean ?: true,
            status = o.get("status")?.takeIf { !it.isJsonNull }?.asString,
        )
    }
}

/**
 * A per-brain CLI MCP server (from mcp.cli_list). These are the codex/claude CLI's
 * OWN MCP servers (codex's ~/.codex/config.toml, claude's ~/.claude.json). By default
 * the brains run ISOLATED and do NOT load them; [enabled] reflects whether it's been
 * imported into the Cindro registry (as "cli:<brain>:<name>").
 */
data class CliMcp(
    val brain: String,
    val name: String,
    val transport: String,
    val enabled: Boolean,
) {
    companion object {
        fun from(o: JsonObject): CliMcp = CliMcp(
            brain = o.get("brain")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            name = o.get("name")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            transport = o.get("transport")?.takeIf { !it.isJsonNull }?.asString ?: "stdio",
            enabled = o.get("enabled")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
        )
    }
}

/** A plugin from plugins.catalog / plugins.list. */
data class Plugin(
    val id: String,
    val name: String?,
    val description: String?,
    val version: String?,
    val installed: Boolean,
    val enabled: Boolean,
) {
    val display: String get() = name?.takeIf { it.isNotBlank() } ?: id

    companion object {
        fun from(o: JsonObject): Plugin = Plugin(
            id = o.get("id")?.asString ?: o.get("name")?.asString.orEmpty(),
            name = o.get("name")?.takeIf { !it.isJsonNull }?.asString,
            description = o.get("description")?.takeIf { !it.isJsonNull }?.asString,
            version = o.get("version")?.takeIf { !it.isJsonNull }?.asString,
            installed = o.get("installed")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
            enabled = o.get("enabled")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
        )
    }
}

/** A memory entry (from memory.list / memory.search). */
data class MemoryEntry(
    val id: String,
    val content: String,
    val target: String?,
    val createdAt: Long?,
) {
    companion object {
        fun from(o: JsonObject): MemoryEntry = MemoryEntry(
            id = o.get("id")?.asString.orEmpty(),
            content = o.get("content")?.takeIf { !it.isJsonNull }?.asString
                ?: o.get("text")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            target = o.get("target")?.takeIf { !it.isJsonNull }?.asString,
            createdAt = o.get("created_at")?.takeIf { !it.isJsonNull }?.asLong
                ?: o.get("created")?.takeIf { !it.isJsonNull }?.asLong
                ?: o.get("ts")?.takeIf { !it.isJsonNull }?.asLong,
        )
    }
}

/** A self-authored skill (from skills.list / skills.get). */
data class Skill(
    val name: String,
    val group: String?,
    val description: String?,
    val tags: List<String>,
    val body: String?,
    // Lifecycle curation (jarvis#76 item 2) — defaults keep old daemons happy.
    val pinned: Boolean = false,
    val useCount: Int = 0,
) {
    val invokeName: String get() = name
    val display: String get() = name

    companion object {
        fun from(o: JsonObject): Skill = Skill(
            name = o.get("name")?.asString.orEmpty(),
            group = o.get("group")?.takeIf { !it.isJsonNull }?.asString,
            description = o.get("description")?.takeIf { !it.isJsonNull }?.asString,
            tags = o.getAsJsonArray("tags")?.mapNotNull {
                it.takeIf { t -> t.isJsonPrimitive }?.asString
            } ?: emptyList(),
            body = o.get("body")?.takeIf { !it.isJsonNull }?.asString,
            pinned = o.get("pinned")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
            useCount = o.get("use_count")?.takeIf { !it.isJsonNull }?.asInt ?: 0,
        )

        /**
         * Build a [Skill] from the skills.get result shape:
         * `{frontmatter:{name,description,tags}, body, path}` (no "skill" wrapper).
         */
        fun fromGet(result: JsonObject): Skill {
            val fm = result.getAsJsonObject("frontmatter") ?: JsonObject()
            return Skill(
                name = fm.get("name")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                group = fm.get("group")?.takeIf { !it.isJsonNull }?.asString,
                description = fm.get("description")?.takeIf { !it.isJsonNull }?.asString,
                tags = fm.getAsJsonArray("tags")?.mapNotNull {
                    it.takeIf { t -> t.isJsonPrimitive }?.asString
                } ?: emptyList(),
                body = result.get("body")?.takeIf { !it.isJsonNull }?.asString,
            )
        }
    }
}

/** A custom agent / subagent (from agents.list / agents.get). */
data class Agent(
    val name: String,
    val description: String?,
    val whenToUse: String?,
    val brain: String?,
    val model: String?,
    val profile: String?,
    val color: String?,
    val systemPrompt: String?,
) {
    companion object {
        private fun JsonObject.s(key: String): String? =
            get(key)?.takeIf { !it.isJsonNull }?.asString

        fun from(o: JsonObject): Agent = Agent(
            name = o.s("name").orEmpty(),
            description = o.s("description"),
            whenToUse = o.s("when_to_use"),
            brain = o.s("brain"),
            model = o.s("model"),
            profile = o.s("profile"),
            color = o.s("color"),
            systemPrompt = o.s("system_prompt"),
        )

        /** Build from agents.get: `{frontmatter:{…}, system_prompt, path}`. */
        fun fromGet(result: JsonObject): Agent {
            val fm = result.getAsJsonObject("frontmatter") ?: JsonObject()
            return Agent(
                name = fm.s("name").orEmpty(),
                description = fm.s("description"),
                whenToUse = fm.s("when_to_use"),
                brain = fm.s("brain"),
                model = fm.s("model"),
                profile = fm.s("profile"),
                color = fm.s("color"),
                systemPrompt = result.s("system_prompt"),
            )
        }
    }
}

/** A "today" agenda item (from skills.today). */
data class TodayItem(val title: String, val detail: String?) {
    companion object {
        fun from(o: JsonObject): TodayItem = TodayItem(
            title = o.get("title")?.asString ?: o.get("text")?.asString.orEmpty(),
            detail = o.get("detail")?.takeIf { !it.isJsonNull }?.asString,
        )
    }
}

/** A file offered by the daemon (file.offer Contract C event). */
data class FileOffer(
    val id: String,
    val name: String,
    val mime: String?,
    val size: Long?,
    val sessionId: String?,
    val b64: String?,
) {
    companion object {
        fun from(o: JsonObject): FileOffer = FileOffer(
            id = o.get("id")?.takeIf { it.isJsonPrimitive }?.asString
                ?: o.get("file_id")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            name = o.get("name")?.takeIf { it.isJsonPrimitive }?.asString ?: "file",
            mime = o.get("mime")?.takeIf { it.isJsonPrimitive }?.asString,
            size = o.get("size")?.takeIf { it.isJsonPrimitive }?.asLong,
            sessionId = o.get("session_id")?.takeIf { it.isJsonPrimitive }?.asString,
            b64 = o.get("b64")?.takeIf { it.isJsonPrimitive }?.asString,
        )
    }
}

/** A session.opened event payload: a new session was created (any surface). */
data class SessionOpened(val sessionId: String, val title: String?) {
    companion object {
        fun from(o: JsonObject): SessionOpened = SessionOpened(
            sessionId = o.get("session_id")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty(),
            title = o.get("title")?.takeIf { it.isJsonPrimitive }?.asString,
        )
    }
}

/** A cross-device unlock challenge pushed over the device WS (the no-Firebase path):
 *  the desktop (or Chrome) asked to unlock; the phone shows the Approve screen. */
data class AuthChallenge(val challengeId: String, val origin: String) {
    companion object {
        fun from(o: JsonObject): AuthChallenge? {
            if (o.get("event")?.takeIf { it.isJsonPrimitive }?.asString != "auth.challenge") return null
            // A non-object `data` (null/string/array) must not ClassCastException here.
            val d = o.get("data")?.takeIf { it.isJsonObject }?.asJsonObject ?: return null
            val cid = d.get("challenge_id")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty()
            if (cid.isEmpty()) return null
            return AuthChallenge(cid, d.get("origin")?.takeIf { it.isJsonPrimitive }?.asString ?: "desktop")
        }
    }
}

/**
 * Decoded `jarvis://pair?host=<tailnet-ip>:8796&code=<code>&fp=<daemon-pubkey-fp>` payload
 * scanned from the desktop QR (or pasted manually).
 */
data class PairPayload(
    val hostPort: String,
    val code: String,
    val fingerprint: String?,
) {
    companion object {
        fun parse(raw: String): PairPayload? {
            val trimmed = raw.trim()
            if (!trimmed.startsWith("jarvis://pair", ignoreCase = true)) return null
            val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
            val host = uri.getQueryParameter("host")?.takeIf { it.isNotBlank() } ?: return null
            val code = uri.getQueryParameter("code")?.takeIf { it.isNotBlank() } ?: return null
            val fp = uri.getQueryParameter("fp")?.takeIf { it.isNotBlank() }
            return PairPayload(host, code, fp)
        }
    }
}
