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
#include "jarvis/HookStore.h"
#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <QString>
#include <functional>
#include <optional>

QT_BEGIN_NAMESPACE
class QNetworkAccessManager;
class QNetworkReply;
class QEventLoop;
class QTimer;
QT_END_NAMESPACE

namespace jarvis {

class ApiBrain : public Brain {
    Q_OBJECT
public:
    struct Options {
        // "openai" | "anthropic" | "mistral" | "ollama" | "gemini" | "xai" |
        // "deepseek" | "" (auto from model/base). gemini/xai/deepseek speak the
        // OpenAI-compatible dialect (jarvis#76 item 11).
        QString provider;
        QString model;
        QString apiKey;      // bearer / x-api-key (empty for ollama)
        // Credential pool (jarvis#76 item 5): when non-empty, requests use
        // pool[m_keyIndex] and an HTTP 429 rotates to the next key before the
        // turn fails. apiKey is the single-key fallback.
        QStringList apiKeyPool;
        // Exponential-backoff retry (jarvis-proxmox-agent): once the credential
        // pool is exhausted (or has <=1 key) a 429 still fails the turn today
        // UNLESS maxBackoffRetries > 0, in which case the brain waits and
        // re-issues the SAME request up to that many times before giving up.
        // Default 0 preserves today's fail-fast behavior for interactive
        // desktop sessions; long-running unattended sessions (e.g. a scheduled
        // headless agent) should set this so a transient rate limit doesn't
        // just kill the turn.
        int maxBackoffRetries = 0;
        int backoffBaseMs = 2000;   // first retry delay, before jitter
        int backoffMaxMs = 60000;   // delay cap, before jitter
        QString baseUrl;     // override; else a sensible per-provider default
        QString systemPrompt; // base system prompt (memory is appended by daemon)
        int maxTokens = 2048;
        // Computer-use MCP endpoint + bearer. When mcpEndpoint is non-empty AND
        // the provider is OpenAI-compatible (not anthropic), the brain advertises
        // that server's tool catalog to the model and runs the function-calling
        // loop. Empty => pure chat (today's behavior).
        QString mcpEndpoint; // e.g. http://127.0.0.1:8794/mcp (or a nested engine)
        QString mcpBearer;   // Bearer for the MCP endpoint (may be empty)
        // Optional per-tool permission gate (daemon-owned). Consulted
        // SYNCHRONOUSLY before each tool is executed: return 0 to allow,
        // non-zero to deny. A deny short-circuits the call — the model gets a
        // {"status":"denied"} tool result and continues without the tool ever
        // running. The daemon supplies this for the permission-gated Proxmox
        // operator session and MAY BLOCK in a nested event loop while asking
        // the user (same pattern as the synchronous MCP client below). Null
        // (default) = no gating, today's behavior.
        std::function<int(const QString &name, const QJsonObject &args)> approveTool;
        // Context compression (jarvis#76 item 6): when > 0 and the estimated
        // prompt exceeds this many tokens, older history is collapsed into a
        // digest before the request (the PreCompact hook fires first and may
        // supply the digest text). 0 = never compress.
        int contextMaxTokens = 0;
        // Optional hook store (daemon-owned) for the PreCompact fire point, and
        // the owning session id for hook payloads.
        HookStore *hooks = nullptr;
        QString sessionId;
        // TODO(resume): when non-empty, should let a re-spawned brain (e.g.
        // after a daemon restart) rebuild m_history from persisted events and
        // resume this session's conversation instead of starting cold. NOT
        // YET IMPLEMENTED — needs a careful pass to reconstruct history
        // without resending tool_calls that never got a matching tool result
        // (unresolved calls would desync the provider's tool-loop state).
        // Flagged for human review; currently unused.
        QString resumeSessionId;
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

    // Exponential backoff with full jitter for retrying a 429 once the
    // credential pool is exhausted: base*2^attempt capped at maxMs, then
    // scaled by a uniform random factor in [0.5, 1.0] (attempt is 0-based).
    static qint64 backoffDelayMs(int attempt, int baseMs, int maxMs);

    // --- context compression helpers (pure; unit-tested) -------------------
    // Rough prompt-size estimate: total content bytes / 4 (chars-per-token
    // heuristic — deliberately cheap, this only gates compression).
    static int estimateHistoryTokens(const QJsonArray &history);
    // Collapse everything but the last `keepTail` entries into ONE digest
    // message spliced at the front. `digest` overrides the built-in heuristic
    // digest (e.g. a PreCompact hook's summary). The kept tail never starts on
    // a {role:"tool"} row (that would orphan tool results from their call).
    // Returns the number of entries removed (0 = nothing to do).
    static int compressHistory(QJsonArray &history, int keepTail,
                               const QString &digest = QString());

    // Test seam (no network): feed one SSE `data:` payload through the streaming
    // parser exactly as drainSse() would. Lets the unit test drive the delta
    // buffering / event contract without a live endpoint.
    void ingestSseDataForTest(const QByteArray &data) { handleSseData(data); }

private slots:
    void onReadyRead();
    void onFinished();

private:
    void emitEvent(const NormalizedBrainEvent &ev);
    // Emit the buffered streamed text as ONE Message event (Contract B: one
    // Message == one complete chat bubble). Called at end of stream, before the
    // tool loop attaches tool_calls, and on cancel (so partial text still shows).
    void flushPendingText();
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

    // Fire PreCompact + compress m_history when past the configured budget.
    void compressIfNeeded();
    // The key requests authenticate with (pool-aware). Empty for ollama.
    QString activeApiKey() const;

    Options m_opts;
    QString m_provider;          // resolved
    bool m_toolsEnabled = false; // mcpEndpoint set && provider != anthropic
    int m_keyIndex = 0;          // credential-pool cursor (sticky across turns)
    int m_keyRotations = 0;      // 429 rotations this turn (reset per send())
    int m_backoffRetries = 0;    // 429 backoff attempts this turn (reset per send())
    QTimer *m_backoffTimer = nullptr; // pending backoff retry (cancel()/dtor stop it)
    QNetworkAccessManager *m_nam = nullptr;
    QNetworkReply *m_reply = nullptr;
    QByteArray m_buf;            // SSE line-assembly buffer
    QString m_pendingText;       // streamed assistant text awaiting flush as ONE Message
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
