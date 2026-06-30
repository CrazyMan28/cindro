// ctest: PURE LOGIC of the ApiBrain function-calling (agentic tool) loop, with
// NO live engine / network. Covers the three pieces the OpenAI-compatible
// (openai/mistral/ollama) tool loop is built on:
//   (a) MCP `tools/list` -> OpenAI `tools[]` conversion,
//   (b) streamed `tool_calls` accumulation across FRAGMENTED SSE deltas, then
//       finalization into a complete {id,name,arguments} array,
//   (c) `finish_reason` detection from a streamed chunk.
//
// These are the static helpers ApiBrain uses in startOpenAi / handleSseData /
// onFinished; exercising them directly proves the wire shapes are right without
// standing up a model or an MCP server.

#include "jarvis/ApiBrain.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QString>

#include <cstdio>

using jarvis::ApiBrain;

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

QJsonObject parseObj(const char *json)
{
    return QJsonDocument::fromJson(QByteArray(json)).object();
}

// One streamed tool_calls delta entry {index,[id],[type],function:{[name],[arguments]}}.
QJsonObject toolCallDelta(int index, const QString &id, const QString &name,
                          const QString &argsFragment)
{
    QJsonObject fn;
    if (!name.isEmpty())
        fn.insert(QStringLiteral("name"), name);
    fn.insert(QStringLiteral("arguments"), argsFragment); // may be a partial fragment
    QJsonObject tc;
    tc.insert(QStringLiteral("index"), index);
    if (!id.isEmpty()) {
        tc.insert(QStringLiteral("id"), id);
        tc.insert(QStringLiteral("type"), QStringLiteral("function"));
    }
    tc.insert(QStringLiteral("function"), fn);
    return tc;
}

} // namespace

int main()
{
    // (a) MCP tool -> OpenAI tools-array conversion -------------------------
    {
        // A normal computer-use tool with a real inputSchema.
        QJsonObject schema = parseObj(R"({
            "type":"object",
            "properties":{"x":{"type":"integer"},"y":{"type":"integer"}},
            "required":["x","y"]
        })");
        QJsonObject click;
        click.insert(QStringLiteral("name"), QStringLiteral("mouse_click"));
        click.insert(QStringLiteral("description"), QStringLiteral("Click at a point"));
        click.insert(QStringLiteral("inputSchema"), schema);

        // A tool with NO description and NO schema (defaults applied).
        QJsonObject shot;
        shot.insert(QStringLiteral("name"), QStringLiteral("screenshot"));

        // A junk entry with no name (must be dropped).
        QJsonObject junk;
        junk.insert(QStringLiteral("description"), QStringLiteral("nameless"));

        QJsonArray mcp;
        mcp.append(click);
        mcp.append(shot);
        mcp.append(junk);

        const QJsonArray out = ApiBrain::mcpToolsToOpenAiTools(mcp);
        check(out.size() == 2, "nameless tool dropped; 2 tools converted");

        const QJsonObject t0 = out[0].toObject();
        check(t0.value(QStringLiteral("type")).toString() == QStringLiteral("function"),
              "tool[0].type == function");
        const QJsonObject fn0 = t0.value(QStringLiteral("function")).toObject();
        check(fn0.value(QStringLiteral("name")).toString() == QStringLiteral("mouse_click"),
              "tool[0].function.name preserved");
        check(fn0.value(QStringLiteral("description")).toString() ==
                  QStringLiteral("Click at a point"),
              "tool[0].function.description preserved");
        check(fn0.value(QStringLiteral("parameters")).toObject() == schema,
              "tool[0].function.parameters IS the MCP inputSchema verbatim");

        const QJsonObject fn1 = out[1].toObject().value(QStringLiteral("function")).toObject();
        check(fn1.value(QStringLiteral("name")).toString() == QStringLiteral("screenshot"),
              "tool[1].function.name preserved");
        check(!fn1.contains(QStringLiteral("description")),
              "tool[1] has no description (none in source)");
        const QJsonObject params1 = fn1.value(QStringLiteral("parameters")).toObject();
        check(params1.value(QStringLiteral("type")).toString() == QStringLiteral("object") &&
                  params1.contains(QStringLiteral("properties")),
              "tool[1].parameters defaulted to an empty object schema");
    }

    // (b) streamed tool_calls accumulation across fragmented SSE deltas -----
    {
        QMap<int, ApiBrain::StreamedToolCall> acc;

        // Frame 1: id+name + first half of the JSON arguments.
        {
            QJsonArray deltas;
            deltas.append(toolCallDelta(0, QStringLiteral("call_abc123"),
                                        QStringLiteral("mouse_click"),
                                        QStringLiteral("{\"x\":1"))); // partial
            ApiBrain::accumulateToolCallDeltas(acc, deltas);
        }
        // Frame 2: NO id/name, just more argument bytes.
        {
            QJsonArray deltas;
            deltas.append(toolCallDelta(0, QString(), QString(),
                                        QStringLiteral("00,\"y\":250}"))); // rest
            ApiBrain::accumulateToolCallDeltas(acc, deltas);
        }

        const QJsonArray fin = ApiBrain::finalizeToolCalls(acc);
        check(fin.size() == 1, "fragmented deltas fold into ONE tool call");
        const QJsonObject o = fin[0].toObject();
        check(o.value(QStringLiteral("id")).toString() == QStringLiteral("call_abc123"),
              "accumulated id correct");
        check(o.value(QStringLiteral("type")).toString() == QStringLiteral("function"),
              "type defaults/keeps function");
        const QJsonObject fn = o.value(QStringLiteral("function")).toObject();
        check(fn.value(QStringLiteral("name")).toString() == QStringLiteral("mouse_click"),
              "accumulated name correct");
        const QString argStr = fn.value(QStringLiteral("arguments")).toString();
        check(argStr == QStringLiteral("{\"x\":100,\"y\":250}"),
              "argument fragments concatenated in order");
        // and the concatenation is valid JSON that parses to the intended object.
        const QJsonObject args = QJsonDocument::fromJson(argStr.toUtf8()).object();
        check(args.value(QStringLiteral("x")).toInt() == 100 &&
                  args.value(QStringLiteral("y")).toInt() == 250,
              "accumulated arguments parse to {x:100,y:250}");
    }

    // (b2) TWO parallel tool calls (distinct indexes) stay ordered + separate.
    {
        QMap<int, ApiBrain::StreamedToolCall> acc;
        QJsonArray deltas;
        deltas.append(toolCallDelta(0, QStringLiteral("call_a"),
                                    QStringLiteral("first"), QStringLiteral("{}")));
        deltas.append(toolCallDelta(1, QStringLiteral("call_b"),
                                    QStringLiteral("second"), QStringLiteral("{}")));
        ApiBrain::accumulateToolCallDeltas(acc, deltas);
        const QJsonArray fin = ApiBrain::finalizeToolCalls(acc);
        check(fin.size() == 2, "two indexes -> two tool calls");
        check(fin[0].toObject().value(QStringLiteral("id")).toString() ==
                  QStringLiteral("call_a"),
              "index 0 first (ordered by index)");
        check(fin[1].toObject().value(QStringLiteral("id")).toString() ==
                  QStringLiteral("call_b"),
              "index 1 second (ordered by index)");
    }

    // (b3) empty arguments default to "{}" so the brain can always JSON-parse them.
    {
        QMap<int, ApiBrain::StreamedToolCall> acc;
        QJsonArray deltas;
        QJsonObject fn; // function with name but no arguments at all
        fn.insert(QStringLiteral("name"), QStringLiteral("screenshot"));
        QJsonObject tc;
        tc.insert(QStringLiteral("index"), 0);
        tc.insert(QStringLiteral("id"), QStringLiteral("call_s"));
        tc.insert(QStringLiteral("function"), fn);
        deltas.append(tc);
        ApiBrain::accumulateToolCallDeltas(acc, deltas);
        const QJsonArray fin = ApiBrain::finalizeToolCalls(acc);
        check(fin.size() == 1, "no-arg tool call still finalized");
        const QString a = fin[0].toObject().value(QStringLiteral("function")).toObject()
                              .value(QStringLiteral("arguments")).toString();
        check(a == QStringLiteral("{}"), "missing arguments default to \"{}\"");
    }

    // (c) finish_reason detection -----------------------------------------
    {
        const QJsonObject toolChunk = parseObj(
            R"({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})");
        check(ApiBrain::finishReasonFromChunk(toolChunk) == QStringLiteral("tool_calls"),
              "finish_reason tool_calls detected");

        const QJsonObject stopChunk = parseObj(
            R"({"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]})");
        check(ApiBrain::finishReasonFromChunk(stopChunk) == QStringLiteral("stop"),
              "finish_reason stop detected");

        // Mid-stream chunk: finish_reason is null/absent -> empty.
        const QJsonObject midChunk = parseObj(
            R"({"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]})");
        check(ApiBrain::finishReasonFromChunk(midChunk).isEmpty(),
              "no finish_reason mid-stream -> empty");

        const QJsonObject noChoices = parseObj(R"({"id":"x","object":"chat.completion.chunk"})");
        check(ApiBrain::finishReasonFromChunk(noChoices).isEmpty(),
              "no choices -> empty finish_reason");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
