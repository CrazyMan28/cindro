// ctest: feed a captured claude stream-json sample through the pure parser and
// assert the normalized sequence (Contract B). The sample is generated live
// from `claude -p --output-format stream-json --verbose "say PONG"` and trimmed
// to spikes/claude_stream_json_sample.jsonl; a synthetic tool-use turn is
// appended in-test to cover tool_call / tool_result mapping (the captured live
// run did not include a tool turn because -p declined the tool).

#include "jarvis/ClaudeParser.h"
#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QFile>
#include <QList>

#include <cstdio>

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

const NormalizedBrainEvent *firstOf(const QList<NormalizedBrainEvent> &evs,
                                    NormalizedBrainEvent::Kind k)
{
    for (const auto &e : evs)
        if (e.kind == k)
            return &e;
    return nullptr;
}

} // namespace

int main(int argc, char **argv)
{
    QString path =
#ifdef JARVIS_CLAUDE_SAMPLE
        QStringLiteral(JARVIS_CLAUDE_SAMPLE);
#else
        QStringLiteral("/home/kihi2024/projects/computer_use/spikes/claude_stream_json_sample.jsonl");
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

    const QList<NormalizedBrainEvent> evs = jarvis::parseClaudeStream(lines);
    std::fprintf(stderr, "parsed %d events from %d lines\n",
                 int(evs.size()), int(lines.size()));
    for (const auto &e : evs)
        std::fprintf(stderr, "  - %s\n",
                     qPrintable(NormalizedBrainEvent::kindToString(e.kind)));

    check(!evs.isEmpty(), "stream produced events");
    check(contains(evs, NormalizedBrainEvent::Kind::ThreadStarted), "has thread_started (system.init)");
    check(contains(evs, NormalizedBrainEvent::Kind::Message), "has message (assistant text PONG)");
    check(contains(evs, NormalizedBrainEvent::Kind::Usage), "has usage (result)");
    check(contains(evs, NormalizedBrainEvent::Kind::Final), "has final (result)");

    // thread_started carries the session id as thread_id.
    if (const auto *t = firstOf(evs, NormalizedBrainEvent::Kind::ThreadStarted))
        check(!t->threadId().isEmpty(), "thread_started carries a thread_id");
    else
        check(false, "thread_started present");

    // The assistant text block is "PONG".
    if (const auto *m = firstOf(evs, NormalizedBrainEvent::Kind::Message))
        check(m->fields.value(QStringLiteral("text")).toString().contains(QStringLiteral("PONG")),
              "assistant message text is PONG");
    else
        check(false, "message present");

    // Ordering: thread_started < message < final.
    int iThread = -1, iMsg = -1, iFinal = -1;
    for (int i = 0; i < evs.size(); ++i) {
        if (iThread < 0 && evs[i].kind == NormalizedBrainEvent::Kind::ThreadStarted) iThread = i;
        if (iMsg < 0 && evs[i].kind == NormalizedBrainEvent::Kind::Message) iMsg = i;
        if (evs[i].kind == NormalizedBrainEvent::Kind::Final) iFinal = i;
    }
    check(iThread >= 0 && iMsg > iThread && iFinal > iMsg,
          "order: thread_started < message < final");

    // --- Synthetic tool-use turn: cover tool_call + tool_result mapping. -----
    // These are the exact content-block shapes claude stream-json emits for a
    // tool turn (Anthropic Messages content blocks).
    QList<QByteArray> toolLines;
    toolLines << QByteArray(R"({"type":"system","subtype":"init","session_id":"sess-tool-1"})")
              << QByteArray(R"({"type":"assistant","message":{"content":[{"type":"text","text":"Running it."},{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"echo HELLO_FROM_TOOL"}}],"usage":{"input_tokens":10,"output_tokens":5}}})")
              << QByteArray(R"({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","is_error":false,"content":[{"type":"text","text":"HELLO_FROM_TOOL"}]}]}})")
              << QByteArray(R"({"type":"assistant","message":{"content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":20,"output_tokens":3}}})")
              << QByteArray(R"({"type":"result","subtype":"success","is_error":false,"result":"Done.","usage":{"input_tokens":20,"output_tokens":3}})");

    const QList<NormalizedBrainEvent> tevs = jarvis::parseClaudeStream(toolLines);
    std::fprintf(stderr, "tool-turn produced %d events\n", int(tevs.size()));
    for (const auto &e : tevs)
        std::fprintf(stderr, "  - %s\n",
                     qPrintable(NormalizedBrainEvent::kindToString(e.kind)));

    check(contains(tevs, NormalizedBrainEvent::Kind::ToolCall), "tool turn: has tool_call");
    check(contains(tevs, NormalizedBrainEvent::Kind::ToolResult), "tool turn: has tool_result");

    if (const auto *tc = firstOf(tevs, NormalizedBrainEvent::Kind::ToolCall)) {
        check(tc->fields.value(QStringLiteral("call_id")).toString() == QStringLiteral("toolu_01"),
              "tool_call call_id == toolu_01");
        check(tc->fields.value(QStringLiteral("name")).toString() == QStringLiteral("Bash"),
              "tool_call name == Bash");
        const QJsonObject args = tc->fields.value(QStringLiteral("args")).toObject();
        check(args.value(QStringLiteral("command")).toString().contains(QStringLiteral("echo")),
              "tool_call args carries the command");
    }
    if (const auto *tr = firstOf(tevs, NormalizedBrainEvent::Kind::ToolResult)) {
        check(tr->fields.value(QStringLiteral("call_id")).toString() == QStringLiteral("toolu_01"),
              "tool_result call_id matches tool_call");
        check(tr->fields.value(QStringLiteral("ok")).toBool() == true,
              "tool_result ok (is_error false)");
        check(tr->fields.value(QStringLiteral("output")).toString().contains(QStringLiteral("HELLO_FROM_TOOL")),
              "tool_result output flattened from content blocks");
    }

    // is_error true -> ok false.
    {
        const QList<QByteArray> errLines = {
            QByteArray(R"({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"boom"}]}})")
        };
        const auto ev = jarvis::parseClaudeStream(errLines);
        check(!ev.isEmpty() && ev.first().kind == NormalizedBrainEvent::Kind::ToolResult &&
                  ev.first().fields.value(QStringLiteral("ok")).toBool() == false,
              "tool_result is_error=true maps to ok=false with string content");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
