#pragma once

// Pure, side-effect-free mapping of `codex exec --json` JSONL lines to
// NormalizedBrainEvents (Contract B). Kept free of QProcess so it is unit
// testable without spawning codex. See CodexBrain for the live process wiring.

#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QList>
#include <optional>

namespace jarvis {

// Parse a single JSONL line emitted by `codex exec --json`.
//
// Returns std::nullopt for blank/non-JSON lines or codex event types that do
// not map to a normalized event. A single codex line maps to at most one
// NormalizedBrainEvent here; the one fan-out case (turn.completed -> usage AND
// final) is handled by parseCodexStream / the live brain, which emit both.
//
// Mapping (verified against codex 0.135.0, see spikes/RESULTS.md):
//   thread.started{thread_id}      -> thread_started{thread_id}
//   turn.started                   -> turn_started
//   turn.completed{usage}          -> usage{...}        (final emitted separately)
//   item.completed{item:{type,..}} -> message/tool_call/tool_result/thinking
//   error{message}                 -> error{message}
std::optional<NormalizedBrainEvent> parseCodexLine(const QByteArray &line);

// Parse a full stream of JSONL lines into the ordered normalized sequence.
// This is where the turn.completed -> {usage, final} fan-out happens: every
// turn.completed yields a usage event immediately followed by a final event.
QList<NormalizedBrainEvent> parseCodexStream(const QList<QByteArray> &lines);

} // namespace jarvis
