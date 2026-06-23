#pragma once

// InjectionGuard — heuristic prompt-injection / risky-action detector
// (BUILD_SPEC "PROMPT-INJECTION GATING" + HERMES_FEATURES.md §5 risk gate).
//
// A pure, dependency-free static scanner. The daemon runs it:
//   - as a SCREENSHOT/ARG SCAN HOOK before an ApiBrain tool call executes, and
//   - over page-text / screenshot-OCR-ish text arguments,
// and, when it flags risk, emits an 'approval' NormalizedBrainEvent and BLOCKS
// the tool call until approval.respond arrives (Anthropic-style confirmation).
//
// Cues (from the spec): "ignore previous instructions", "exfiltrate" /
// "send my/your credentials|cookies|password", an unexpected external POST, a
// large base64 blob embedded in page text, "disregard the above", etc.
//
// For CLI brains (codex / claude) this CANNOT intercept mid-loop because they
// run their own tool loop in-process; those rely on the CLIs' own approval
// modes (documented in docs/HERMES_FEATURES.md). InjectionGuard still scans the
// USER turn + any screenshot text the daemon sees for those brains.

#include <QString>
#include <QStringList>

namespace jarvis {

class InjectionGuard {
public:
    // The outcome of a scan.
    struct Result {
        bool risky = false;        // true => caller should gate (approval)
        QString risk;              // "low" | "medium" | "high"
        QStringList cues;          // which heuristics fired (for the summary)

        // A short one-line summary suitable for an approval card.
        QString summary() const;
    };

    // Scan free-form text (page text, an argument string, a screenshot's OCR).
    // `context` (e.g. a tool name or "page_text") is folded into the summary.
    static Result scanText(const QString &text, const QString &context = QString());

    // Scan a tool call: the tool name + its JSON args rendered to a string.
    // Adds extra heuristics for an unexpected external network POST (a tool that
    // sends data to an off-host URL) on top of the text cues in the args.
    static Result scanToolCall(const QString &toolName, const QString &argsJson);

    // Convenience: is this risk tier one that must be gated (medium/high)?
    static bool shouldGate(const Result &r) { return r.risky; }
};

} // namespace jarvis
