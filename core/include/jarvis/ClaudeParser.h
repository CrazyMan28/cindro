#pragma once

// Pure, side-effect-free mapping of `claude -p --output-format stream-json
// --verbose` JSONL lines to NormalizedBrainEvents (Contract B). Kept free of
// QProcess so it is unit-testable without spawning claude. ClaudeBrain owns the
// live process wiring.
//
// Stream shapes captured from claude 2.1.170 (see spikes/claude_stream_json_sample.jsonl):
//   {"type":"system","subtype":"init", "session_id":"<id>", ...}
//       -> thread_started{thread_id=session_id}
//   {"type":"assistant","message":{"content":[
//         {"type":"thinking","thinking":"..."}            -> thinking{text}
//         {"type":"text","text":"..."}                    -> message{assistant,text}
//         {"type":"tool_use","id","name","input":{...}}   -> tool_call{call_id=id,name,args=input}
//       ], "usage":{input_tokens,output_tokens,...}}}      -> usage (emitted by stream)
//   {"type":"user","message":{"content":[
//         {"type":"tool_result","tool_use_id","content","is_error"}]}}
//                                                          -> tool_result{call_id,ok=!is_error,output}
//   {"type":"result","subtype":"success","result":"...","usage":{...}}
//       -> usage{...} then final{}
//   {"type":"result","is_error":true,...} / {"type":"system","subtype":"error"}
//       -> error{message}
//
// System hook_started/hook_response/init-noise and rate_limit_event lines map to
// nothing (std::nullopt).

#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QList>
#include <optional>

namespace jarvis {

// Parse a single claude stream-json line into zero-or-more normalized events.
// An assistant message can carry several content blocks (thinking + text +
// tool_use), so unlike the codex parser a single line may yield MANY events —
// hence a list. Blank/non-JSON/uninteresting lines yield an empty list.
QList<NormalizedBrainEvent> parseClaudeLine(const QByteArray &line);

// Parse a full stream into the ordered normalized sequence. The terminal
// `result` line yields {usage, final}; a turn that errors yields {error}.
QList<NormalizedBrainEvent> parseClaudeStream(const QList<QByteArray> &lines);

} // namespace jarvis
