package com.agentphone.ui.state

import org.json.JSONObject

/**
 * The enrollment package returned by POST /api/agents/enroll. Kept loose
 * (string fields + raw JSON blobs) so it survives server-side additions
 * without app updates — the UI just renders what it gets.
 */
data class EnrollmentPackage(
    val bootstrapId: String,
    val extension: String,
    val agentId: String,
    val name: String,
    val adapterType: String,
    val token: String,
    val serverUrl: String,
    val wsUrl: String,
    val bootstrapUrl: String,
    val bootstrapCmd: String,
    val expiresAt: String,
    val mcpConfigJson: String,
    val fullJson: String
) {
    companion object {
        fun fromJson(json: JSONObject): EnrollmentPackage {
            val mcp = json.optJSONObject("mcpConfig") ?: JSONObject()
            return EnrollmentPackage(
                bootstrapId = json.optString("bootstrapId"),
                extension = json.optString("extension"),
                agentId = json.optString("agentId"),
                name = json.optString("name"),
                adapterType = json.optString("adapterType"),
                token = json.optString("token"),
                serverUrl = json.optString("serverUrl"),
                wsUrl = json.optString("wsUrl"),
                bootstrapUrl = json.optString("bootstrapUrl"),
                bootstrapCmd = json.optString("bootstrapCmd"),
                expiresAt = json.optString("expiresAt"),
                mcpConfigJson = mcp.toString(2),
                fullJson = json.toString(2)
            )
        }
    }
}
