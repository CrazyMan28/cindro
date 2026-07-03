// ctest: ToolLoopGuard repeated-call detection (jarvis#76 item 4). Pure logic —
// no daemon, no network.

#include "jarvis/ToolLoopGuard.h"

#include <QCoreApplication>

#include <cstdio>

using jarvis::ToolLoopGuard;

namespace {
int g_failures = 0;
void check(bool cond, const char *msg)
{
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", msg); ++g_failures; }
    else { std::fprintf(stderr, "ok: %s\n", msg); }
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // Identical (tool,args,result) triples: quiet below softN, warn at softN,
    // stop at hardN.
    {
        QList<ToolLoopGuard::Entry> w;
        ToolLoopGuard::Result r;
        for (int i = 1; i < ToolLoopGuard::kSoftRepeats; ++i) {
            r = ToolLoopGuard::observe(w, "mouse_click", "{\"x\":1}", "no change");
            check(!r.softWarn && !r.hardStop, "quiet below softN");
        }
        r = ToolLoopGuard::observe(w, "mouse_click", "{\"x\":1}", "no change");
        check(r.softWarn && !r.hardStop, "softWarn at exactly softN");
        check(r.repeatCount == ToolLoopGuard::kSoftRepeats, "repeatCount at softN");
        for (int i = ToolLoopGuard::kSoftRepeats; i < ToolLoopGuard::kHardRepeats - 1; ++i)
            r = ToolLoopGuard::observe(w, "mouse_click", "{\"x\":1}", "no change");
        r = ToolLoopGuard::observe(w, "mouse_click", "{\"x\":1}", "no change");
        check(r.hardStop, "hardStop at hardN");
        check(r.toolName == QStringLiteral("mouse_click"), "verdict names the tool");
    }

    // Different tools / different args don't cross-contaminate.
    {
        QList<ToolLoopGuard::Entry> w;
        for (int i = 0; i < 10; ++i) {
            const auto r = ToolLoopGuard::observe(
                w, "bg_start", QStringLiteral("{\"cmd\":%1}").arg(i), "ok");
            check(!r.softWarn && !r.hardStop, "distinct args stay quiet");
        }
        const auto r1 = ToolLoopGuard::observe(w, "toolA", "{}", "same");
        const auto r2 = ToolLoopGuard::observe(w, "toolB", "{}", "same");
        check(!r1.softWarn && !r2.softWarn, "different tool names tracked separately");
    }

    // Result-varying churn on the identical call trips at 2x thresholds.
    {
        QList<ToolLoopGuard::Entry> w;
        ToolLoopGuard::Result r;
        for (int i = 0; i < 2 * ToolLoopGuard::kSoftRepeats - 1; ++i) {
            r = ToolLoopGuard::observe(
                w, "run_cmd", "{\"cmd\":\"make\"}",
                QStringLiteral("error at %1s").arg(i)); // result differs each time
        }
        check(!r.hardStop, "churn below 2x hardN not stopped");
        r = ToolLoopGuard::observe(w, "run_cmd", "{\"cmd\":\"make\"}", "error at 99s");
        check(r.softWarn, "churn softWarn at 2x softN identical calls");
        for (int i = 0; i < 2 * ToolLoopGuard::kHardRepeats; ++i)
            r = ToolLoopGuard::observe(w, "run_cmd", "{\"cmd\":\"make\"}",
                                       QStringLiteral("err %1").arg(1000 + i));
        check(r.hardStop, "churn hardStop at 2x hardN identical calls");
    }

    // Truncation: only the first 800 chars of args/result feed the hash, so
    // giant outputs that differ past the cap still count as repeats.
    {
        QList<ToolLoopGuard::Entry> w;
        const QString big(9000, QLatin1Char('x'));
        ToolLoopGuard::Result r;
        for (int i = 0; i < ToolLoopGuard::kSoftRepeats; ++i)
            r = ToolLoopGuard::observe(w, "read_file", "{}",
                                       big + QStringLiteral("tail-%1").arg(i));
        check(r.softWarn, "identical-beyond-cap results count as repeats");
    }

    // Fields joined with pipes must NOT collide: ("ls|x","y") vs ("ls","x|y").
    {
        QList<ToolLoopGuard::Entry> w;
        for (int i = 0; i < 2; ++i)
            ToolLoopGuard::observe(w, "t", "ls|x", "y");
        const auto r = ToolLoopGuard::observe(w, "t", "ls", "x|y");
        check(w.size() == 2, "pipe-shifted fields hash to distinct entries");
        check(!r.softWarn, "no cross-contamination between the two shapes");
    }

    // reset() clears the window.
    {
        QList<ToolLoopGuard::Entry> w;
        for (int i = 0; i < ToolLoopGuard::kSoftRepeats; ++i)
            ToolLoopGuard::observe(w, "t", "{}", "r");
        ToolLoopGuard::reset(w);
        const auto r = ToolLoopGuard::observe(w, "t", "{}", "r");
        check(!r.softWarn && w.size() == 1, "reset clears counts");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "tool_loop_guard_test: all checks passed\n");
    return g_failures == 0 ? 0 : 1;
}
