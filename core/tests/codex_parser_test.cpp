// ctest: feed spikes/codex_jsonl_sample.jsonl through the pure parser and
// assert the normalized sequence contains thread_started, turn_started, usage
// and final (Contract B). No process is spawned — parseCodexStream is pure.

#include "jarvis/CodexParser.h"
#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QFile>
#include <QList>

#include <cstdio>
#include <cstdlib>

using jarvis::NormalizedBrainEvent;

namespace {

int g_failures = 0;

void check(bool cond, const char *msg)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok: %s\n", msg);
    }
}

bool contains(const QList<NormalizedBrainEvent> &evs, NormalizedBrainEvent::Kind k)
{
    for (const auto &e : evs)
        if (e.kind == k)
            return true;
    return false;
}

} // namespace

int main(int argc, char **argv)
{
    // Sample path: argv[1] overrides; else the compile-time SAMPLE_PATH define.
    QString path =
#ifdef JARVIS_CODEX_SAMPLE
        QStringLiteral(JARVIS_CODEX_SAMPLE);
#else
        QStringLiteral("/home/user/projects/computer_use/spikes/codex_jsonl_sample.jsonl");
#endif
    if (argc > 1)
        path = QString::fromLocal8Bit(argv[1]);

    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        std::fprintf(stderr, "FAIL: cannot open sample %s\n", qPrintable(path));
        return 2;
    }

    QList<QByteArray> lines;
    while (!f.atEnd())
        lines.push_back(f.readLine());
    f.close();

    const QList<NormalizedBrainEvent> evs = jarvis::parseCodexStream(lines);

    std::fprintf(stderr, "parsed %d normalized events from %d lines\n",
                 int(evs.size()), int(lines.size()));
    for (const auto &e : evs)
        std::fprintf(stderr, "  - %s\n",
                     qPrintable(NormalizedBrainEvent::kindToString(e.kind)));

    check(!evs.isEmpty(), "stream produced events");
    check(contains(evs, NormalizedBrainEvent::Kind::ThreadStarted), "has thread_started");
    check(contains(evs, NormalizedBrainEvent::Kind::TurnStarted), "has turn_started");
    check(contains(evs, NormalizedBrainEvent::Kind::Usage), "has usage");
    check(contains(evs, NormalizedBrainEvent::Kind::Final), "has final");

    // thread_started must carry the thread_id from the sample.
    bool threadIdOk = false;
    for (const auto &e : evs) {
        if (e.kind == NormalizedBrainEvent::Kind::ThreadStarted)
            threadIdOk = !e.threadId().isEmpty();
    }
    check(threadIdOk, "thread_started carries a thread_id");

    // Ordering: thread_started precedes turn_started precedes final.
    int iThread = -1, iTurn = -1, iFinal = -1;
    for (int i = 0; i < evs.size(); ++i) {
        if (iThread < 0 && evs[i].kind == NormalizedBrainEvent::Kind::ThreadStarted) iThread = i;
        if (iTurn < 0 && evs[i].kind == NormalizedBrainEvent::Kind::TurnStarted) iTurn = i;
        if (evs[i].kind == NormalizedBrainEvent::Kind::Final) iFinal = i;
    }
    check(iThread >= 0 && iTurn > iThread && iFinal > iTurn,
          "order: thread_started < turn_started < final");

    // Round-trip a normalized event through JSON.
    {
        const NormalizedBrainEvent m = NormalizedBrainEvent::message(
            QStringLiteral("assistant"), QStringLiteral("PONG"));
        const auto rt = NormalizedBrainEvent::fromJson(m.toJson());
        check(rt.has_value() && rt->kind == NormalizedBrainEvent::Kind::Message &&
                  rt->fields.value(QStringLiteral("text")).toString() == QStringLiteral("PONG"),
              "NormalizedBrainEvent JSON round-trip");
    }

    // A COMPLETED mcp_tool_call (one item carrying call + result) must keep the
    // tool name, input args, and server on the result — so the chat card shows
    // input + output, not just output.
    {
        const QByteArray line =
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"call_9\","
            "\"type\":\"mcp_tool_call\",\"server\":\"computer-use\",\"name\":\"screenshot\","
            "\"status\":\"completed\",\"arguments\":{\"which\":\"real\"},"
            "\"output\":\"<png>\"}}\n";
        const auto evs2 = jarvis::parseCodexStream({line});
        const NormalizedBrainEvent *tr = nullptr;
        for (const auto &e : evs2)
            if (e.kind == NormalizedBrainEvent::Kind::ToolResult)
                tr = &e;
        check(tr != nullptr, "completed mcp_tool_call -> a tool_result");
        check(tr && tr->fields.value(QStringLiteral("name")).toString() == QStringLiteral("screenshot"),
              "tool_result carries the tool name");
        check(tr && tr->fields.value(QStringLiteral("server")).toString() == QStringLiteral("computer-use"),
              "tool_result carries the server");
        check(tr && tr->fields.value(QStringLiteral("args")).toObject()
                        .value(QStringLiteral("which")).toString() == QStringLiteral("real"),
              "tool_result carries the input args");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
