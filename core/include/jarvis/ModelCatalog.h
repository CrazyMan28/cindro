#pragma once

// Pure parsing/merge helpers for the dynamic model-discovery feature: instead
// of ControlServer::modelsForBrain()'s hardcoded arrays going stale every time
// OpenAI/Anthropic ship a new model, the daemon fetches each CLI brain's real
// catalog and merges it in. See AGENTS.md's "Dynamic model discovery" entry
// for the design (async fetch, TTL cache, fail-open on any shape mismatch —
// both source subcommands/endpoints here are undocumented-ish enough that a
// parser must never throw or crash on unexpected input).
//
// Kept here (not inline in daemon/src/ControlServer.cpp) so it's testable
// without spinning up a full ControlServer/QWebSocketServer instance, per this
// repo's "business logic lives in core/, tested by core/tests" convention.

#include <QByteArray>
#include <QJsonArray>

namespace jarvis {

struct ModelCatalogResult {
    QJsonArray models;
    // True iff the expected top-level JSON shape was found, even if the
    // resulting model list came back empty. False means "don't trust this
    // result at all" (caller should keep whatever it had before and retry
    // sooner) — NOT the same as "the shape was fine but there were zero
    // models" (caller can treat that as a normal, longer-lived result).
    bool ok = false;
};

// Parses `codex debug models --bundled`'s stdout: a top-level JSON OBJECT with
// a "models" array of {slug, visibility, ...}. Returns the visible
// (visibility != "hide") slugs, in catalog order. `codex debug` is an
// explicitly unofficial/undocumented subcommand, not part of codex's stable
// --help surface — ok=false on ANY shape mismatch, never a thrown exception.
ModelCatalogResult parseCodexModelCatalog(const QByteArray &processStdout);

// Parses a `GET https://api.anthropic.com/v1/models` response body: a
// top-level JSON OBJECT with a "data" array of {id, ...}. Returns the model
// ids, in catalog order. This IS the public, documented Anthropic Models API
// (just authenticated with the Claude Code CLI's own OAuth token instead of a
// separate API key) but the parser stays just as defensive as the codex one.
ModelCatalogResult parseClaudeModelCatalog(const QByteArray &body);

// Appends `live` onto `baseline`, case/whitespace-insensitive deduped against
// entries already present. `baseline` entries are never reordered or dropped —
// callers that treat "first entry" as the default model are unaffected by
// whatever is (or isn't) in `live` at merge time.
QJsonArray mergeModelCatalogs(const QJsonArray &baseline, const QJsonArray &live);

} // namespace jarvis
