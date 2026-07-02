#include "jarvis/ToolLoopGuard.h"

#include <QCryptographicHash>

namespace jarvis {

namespace {
// Cap the hashed portion so a multi-MB tool output never allocates a huge
// intermediate on every ToolResult event.
constexpr int kHashInputCap = 800;

QByteArray hashOf(const QString &a, const QString &b, const QString &c)
{
    const QString joined = a + QLatin1Char('|') + b.left(kHashInputCap) +
                           QLatin1Char('|') + c.left(kHashInputCap);
    return QCryptographicHash::hash(joined.toUtf8(), QCryptographicHash::Sha1);
}
} // namespace

ToolLoopGuard::Result ToolLoopGuard::observe(QList<Entry> &window, const QString &name,
                                             const QString &argsJson,
                                             const QString &result,
                                             int softN, int hardN)
{
    Result verdict;
    verdict.toolName = name;

    const QByteArray full = hashOf(name, argsJson, result);
    const QByteArray call = hashOf(name, argsJson, QString());

    Entry *hit = nullptr;
    for (Entry &e : window) {
        if (e.hash == full) {
            hit = &e;
            break;
        }
    }
    if (!hit) {
        Entry e;
        e.hash = full;
        e.callHash = call;
        e.toolName = name;
        window.append(e);
        hit = &window.last();
    }
    ++hit->count;

    // Result-independent churn counter: identical (tool, args) across ALL
    // window entries, regardless of what came back.
    int callRepeats = 0;
    for (const Entry &e : window)
        if (e.callHash == call)
            callRepeats += e.count;

    // Exact repeats trip at the base thresholds; result-varying churn on the
    // identical call trips at 2x (more benign — polling a changing status is
    // legitimate for a while).
    verdict.repeatCount = qMax(hit->count, callRepeats > hit->count ? callRepeats / 2 : 0);
    const int exact = hit->count;
    verdict.softWarn = exact >= softN || callRepeats >= 2 * softN;
    verdict.hardStop = exact >= hardN || callRepeats >= 2 * hardN;
    if (verdict.hardStop)
        verdict.repeatCount = qMax(exact, callRepeats);
    return verdict;
}

} // namespace jarvis
