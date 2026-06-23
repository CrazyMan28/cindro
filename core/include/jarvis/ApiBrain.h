#pragma once

// ApiBrain — a direct streaming LLM loop (Contract B), no CLI subprocess.
//
// Two wire dialects, auto-selected from the model id (or an explicit `provider`):
//   - OpenAI-compatible  POST <base>/chat/completions  (SSE `data:` deltas).
//     Covers OpenAI, and Ollama at http://127.0.0.1:11434/v1 (no key needed).
//   - Anthropic          POST <base>/messages          (SSE event/data deltas).
//
// Emits thread_started (synthetic id) -> turn_started -> message/thinking chunks
// -> usage -> final, mapping streamed deltas into NormalizedBrainEvents. Memory
// is injected by the daemon as a system block before send(). A basic MCP tool
// loop is a future bonus; this implementation streams assistant text + usage.

#include "jarvis/Brain.h"
#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QJsonArray>
#include <QString>

QT_BEGIN_NAMESPACE
class QNetworkAccessManager;
class QNetworkReply;
QT_END_NAMESPACE

namespace jarvis {

class ApiBrain : public Brain {
    Q_OBJECT
public:
    struct Options {
        // "openai" | "anthropic" | "ollama" | "" (auto from model/base).
        QString provider;
        QString model;
        QString apiKey;      // bearer / x-api-key (empty for ollama)
        QString baseUrl;     // override; else a sensible per-provider default
        QString systemPrompt; // base system prompt (memory is appended by daemon)
        int maxTokens = 2048;
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

private slots:
    void onReadyRead();
    void onFinished();

private:
    void emitEvent(const NormalizedBrainEvent &ev);
    void startOpenAi(const QString &text);
    void startAnthropic(const QString &text);
    void drainSse();
    void handleSseData(const QByteArray &data); // one `data:` payload (sans prefix)

    Options m_opts;
    QString m_provider;          // resolved
    QNetworkAccessManager *m_nam = nullptr;
    QNetworkReply *m_reply = nullptr;
    QByteArray m_buf;            // SSE line-assembly buffer
    bool m_busy = false;
    bool m_emittedFinal = false;
    bool m_anySent = false;      // whether we streamed any assistant text
    QJsonArray m_history;        // [{role,content}] conversation memory

    void finishTurn(); // emit usage(if any)+final exactly once, mark idle
    QJsonObject m_lastUsage;
};

} // namespace jarvis
