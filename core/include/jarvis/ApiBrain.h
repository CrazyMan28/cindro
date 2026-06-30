#pragma once

// ApiBrain — a direct streaming LLM loop (Contract B), no CLI subprocess.
//
// Two wire dialects, auto-selected from the model id (or an explicit `provider`):
//   - OpenAI-compatible  POST <base>/chat/completions  (SSE `data:` deltas).
//     Covers OpenAI, Mistral (https://api.mistral.ai/v1, mistral-* model ids),
//     and Ollama at http://127.0.0.1:11434/v1 (no key needed).
//   - Anthropic          POST <base>/messages          (SSE event/data deltas).
//
// Emits thread_started (synthetic id) -> turn_started -> message/thinking chunks
// -> usage -> final, mapping streamed deltas into NormalizedBrainEvents. Memory
// is injected by the daemon as a system block before send().
//
// FUNCTION-CALLING (agentic tool) loop: when `Options::mcpEndpoint` is set AND
// the provider is OpenAI-compatible (openai / mistral / ollama — NOT anthropic),
// the brain advertises the computer-use MCP tool catalog to the model and runs a
// tool loop: it accumulates streamed `tool_calls`, and when a turn finishes with
// `finish_reason == "tool_calls"` it executes each call against the MCP endpoint
// (a synchronous initialize / tools-call client, mirroring McpRegistry::testHttp),
// appends the tool results to the running history, and re-issues the chat request
// (capped at 12 iterations). Anthropic stays chat-only (different tool format).

#include "jarvis/Brain.h"
#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <QString>
#include <optional>

QT_BEGIN_NAMESPACE
class QNetworkAccessManager;
class QNetworkReply;
class QEventLoop;
QT_END_NAMESPACE

namespace jarvis {

class ApiBrain : public Brain {
    Q_OBJECT
public:
    struct Options {
        // "openai" | "anthropic" | "mistral" | "ollama" | "" (auto from model/base).
        QString provider;
        QString model;
        QString apiKey;      // bearer / x-api-key (empty for ollama)
        QString baseUrl;     // override; else a sensible per-provider default
        QString systemPrompt; // base system prompt (memory is appended by daemon)
        int maxTokens = 2048;
        // Computer-use MCP endpoint + bearer. When mcpEndpoint is non-empty AND
        // the provider is OpenAI-compatible (not anthropic), the brain advertises
        // that server's tool catalog to the model and runs the function-calling
        // loop. Empty => pure chat (today's behavior).
        QString mcpEndpoint; // e.g. http://127.0.0.1:8794/mcp (or a nested engine)
        QString mcpBearer;   // Bearer for the MCP endpoint (may be empty)
    };

    explicit ApiBrain(Options opts, QObject *parent = nullptr);
    ~ApiBrain() override;

    void send(const QString &text, const QStringList &images = {}) override;
    void cancel() override;
    bool isBusy() const override;

    // Resolve the effective provider from options (model id heuristics).
    static QString resolveProvider(const Options &opts);
    // Default base URL for a provider.
    static QString defaultBaseUrl(const QString &provider);

    // --- pure tool-loop helpers (unit-tested; no network) -----------------

    // One streamed OpenAI `tool_calls[]` entry being assembled across SSE deltas:
    // the id/type/name arrive once, the `arguments` JSON streams as fragments.
    struct StreamedToolCall {
        QString id;
        QString type;       // "function"
        QString name;
        QString arguments;  // accumulated JSON string fragments
    };

    // Convert an MCP `tools/list` result `tools[]` ({name,description,inputSchema})
    // into an OpenAI `tools[]` array ({type:"function",function:{name,description,
    // parameters:<inputSchema>}}). Skips entries with no name; defaults a missing
    // schema to an empty object schema.
    static QJsonArray mcpToolsToOpenAiTools(const QJsonArray &mcpTools);

    // Fold one streamed `choices[].delta.tool_calls` array into `acc`, keyed by the
    // delta's `index` (arguments fragments concatenate; id/type/name set when seen).
    static void accumulateToolCallDeltas(QMap<int, StreamedToolCall> &acc,
                                         const QJsonArray &deltaToolCalls);

    // Finalize the accumulator into an ordered OpenAI `tool_calls[]` array
    // ([{id,type:"function",function:{name,arguments}}]); empty args -> "{}".
    static QJsonArray finalizeToolCalls(const QMap<int, StreamedToolCall> &acc);

    // The first non-empty `choices[].finish_reason` of a streamed chunk ("" if none).
    static QString finishReasonFromChunk(const QJsonObject &chunk);

private slots:
    void onReadyRead();
    void onFinished();

private:
    void emitEvent(const NormalizedBrainEvent &ev);
    void startOpenAi(const QString &text);
    void startAnthropic(const QString &text);
    // Build the user-message `content`: a plain string when there are no images,
    // else a vision content array (text + base64 image parts) in the provider's
    // format (OpenAI image_url / Anthropic image source). `images` are file paths.
    QJsonValue userContent(const QString &text, const QStringList &images) const;
    void drainSse();
    void handleSseData(const QByteArray &data); // one `data:` payload (sans prefix)

    // --- function-calling tool loop ---------------------------------------
    // Synchronous MCP HTTP client (nested QEventLoop, mirrors McpRegistry::testHttp).
    bool mcpPost(const QByteArray &body, int wantId, std::optional<QJsonObject> *out);
    bool ensureMcpInitialized();          // initialize + notifications/initialized (once)
    QJsonArray fetchMcpTools();           // tools/list -> cached OpenAI tools[] (once)
    bool callMcpTool(const QString &name, const QJsonObject &args, QString *output);
    // After a stream that finished with finish_reason=="tool_calls": append the
    // assistant tool_calls msg, run each call, append tool results, and re-issue
    // the chat request (or stop at the iteration cap). Replaces finishTurn() for
    // that turn.
    void runToolCallsAndContinue();

    Options m_opts;
    QString m_provider;          // resolved
    bool m_toolsEnabled = false; // mcpEndpoint set && provider != anthropic
    QNetworkAccessManager *m_nam = nullptr;
    QNetworkReply *m_reply = nullptr;
    QByteArray m_buf;            // SSE line-assembly buffer
    bool m_busy = false;
    bool m_emittedFinal = false;
    bool m_anySent = false;      // whether we streamed any assistant text
    bool m_cancelled = false;    // cancel() requested; stop the loop
    QJsonArray m_history;        // [{role,content}|tool_calls|tool] conversation memory

    // Per-request stream accumulation (reset before each chat request).
    QMap<int, StreamedToolCall> m_toolAccum;
    QString m_finishReason;
    int m_toolIterations = 0;    // tool-loop iterations this turn (cap 12)

    // MCP client session state (cached for the brain's lifetime).
    QString m_mcpSessionId;
    bool m_mcpInitDone = false;
    bool m_toolsFetched = false; // tools/list attempted (cache m_toolsCatalog)
    QJsonArray m_toolsCatalog;   // OpenAI tools[] (empty if none / fetch failed)
    int m_mcpRpcId = 0;
    QNetworkReply *m_mcpReply = nullptr; // in-flight synchronous MCP reply (for cancel)
    QEventLoop *m_mcpLoop = nullptr;      // its event loop (cancel quits it)

    void finishTurn(); // emit usage(if any)+final exactly once, mark idle
    QJsonObject m_lastUsage;
};

} // namespace jarvis
