#pragma once

// ToolLoopGuard — tool-loop guardrails (jarvis#76 item 4).
//
// Detects a brain stuck repeating the SAME tool call with the SAME result
// (classic unattended-runaway: retrying a failing command forever, burning
// budget with nobody watching). Pure and stateless like InjectionGuard: the
// per-session window lives in ControlServer; observe() hashes one
// (tool, args, result) triple into it and returns a verdict.
//
//   - softWarn at kSoftRepeats identical triples: queue a "[TOOL LOOP
//     WARNING]" turn so the brain reconsiders on its next turn (CLI brains
//     cannot be interrupted mid-loop — see InjectionGuard.h).
//   - hardStop at kHardRepeats: cancel the turn and surface an anomaly.
//
// A secondary counter keyed on (tool, args) ONLY (ignoring the result) catches
// churn-loops where an error message varies per attempt (timestamps etc.) but
// the model keeps issuing the identical call; it trips at 2x the thresholds.

#include <QByteArray>
#include <QList>
#include <QString>

namespace jarvis {

class ToolLoopGuard {
public:
    static constexpr int kSoftRepeats = 3;
    static constexpr int kHardRepeats = 5;

    struct Entry {
        QByteArray hash;     // hash(tool|args|result)
        QByteArray callHash; // hash(tool|args) — result-independent
        int count = 0;
        int callCount = 0;
        QString toolName;
    };

    struct Result {
        bool softWarn = false;
        bool hardStop = false;
        int repeatCount = 0;
        QString toolName;
    };

    // Record one completed tool call into `window` and return the verdict.
    // args/result are truncated before hashing so huge outputs stay cheap.
    static Result observe(QList<Entry> &window, const QString &name,
                          const QString &argsJson, const QString &result,
                          int softN = kSoftRepeats, int hardN = kHardRepeats);

    static void reset(QList<Entry> &window) { window.clear(); }
};

} // namespace jarvis
