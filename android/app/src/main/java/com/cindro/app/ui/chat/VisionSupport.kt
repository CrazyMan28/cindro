package com.cindro.app.ui.chat

/**
 * Client-side mirror of what each brain does with attached images — same intent as
 * desktop's `Bridge::supportsVision` (desktop/src/Bridge.cpp) and the extension's
 * `supportsVision()` (extension/sidepanel.js), but using the corrected polarity:
 * ALLOW unless the model is a KNOWN text-only family, rather than deny-unless-known-
 * vision. That way a newer/unrecognized vision-capable model is never silently
 * blocked — the api brain builds a vision content array for basically everything
 * except a short list of text-only legacy models.
 *
 * codex (passes `--image`) and claude (reads the file with its Read tool) see
 * images regardless of the selected model, so they're always-true.
 *
 * Longer term this should read an actual vision flag off `model.list` instead of a
 * name heuristic (tracked alongside the desktop/extension counterparts).
 */
object VisionSupport {

    /** Known TEXT-ONLY model-name fragments (api brain). Deliberately short — when in
     *  doubt this predicate ALLOWS, so attaching a photo never silently no-ops. */
    private val TEXT_ONLY_HINTS = listOf(
        "gpt-3.5", "text-davinci", "text-curie", "text-babbage", "text-ada",
        "davinci-", "curie-", "babbage-", "ada-",
        "code-davinci", "code-cushman",
        "whisper", "embedding", "moderation", "tts-", "dall-e",
    )

    /**
     * @param brain "codex" | "claude" | "api" (or unknown/blank).
     * @param model the model id, when known (api brain only — codex/claude ignore it).
     */
    fun supportsVision(brain: String?, model: String?): Boolean {
        if (brain == "codex" || brain == "claude") return true
        val m = model?.trim()?.lowercase().orEmpty()
        if (m.isBlank()) return true // unknown model: fail open, never silently block
        return TEXT_ONLY_HINTS.none { m.contains(it) }
    }
}
