#pragma once

// TrustPolicyStore — per-tool / per-app trust policies (jarvis#71).
//
// The daemon-side owner of ~/.config/jarvis/trust_policies.json — the SAME file
// the computer-use engine's policy gate enforces on every tool call (engine:
// computer_use_mcp/policy.py). This class does CRUD + the mirror evaluation
// (for policy.test and UI previews) + a preamble clause so the model knows the
// rules up front instead of discovering them by being blocked.
//
//   { "version": 1, "default": "allow",
//     "rules": [ { "id": "ask-payments", "tool": "browser_*", "app": "*bank*",
//                  "action": "allow"|"ask"|"deny", "note": "..." } ] }
//
// Matching (identical to the engine): `tool`/`app` are glob patterns; tool is
// case-sensitive, app is case-insensitive; the MOST SPECIFIC matching rule wins
// (most non-wildcard characters across both patterns), ties go to the earliest
// rule. No matching rule -> "default".

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

namespace jarvis {

struct TrustDecision {
    QString action;  // allow | ask | deny
    QString ruleId;  // matching rule id ("" = default)
    QString note;
};

class TrustPolicyStore {
public:
    // Default: ~/.config/jarvis/trust_policies.json. A non-empty `root` makes a
    // store on <root>/trust_policies.json (unit tests).
    explicit TrustPolicyStore(const QString &root = QString());

    QString filePath() const { return m_path; }

    // (Re)load from disk. Missing file => empty rules, default allow.
    void load();
    bool save() const;

    // The whole config (policy.list).
    QJsonObject toJson() const;

    // CRUD — all persist on success. add() generates an id from the note/tool
    // when none is given and returns it ("" = failure).
    QString addRule(const QString &tool, const QString &app,
                    const QString &action, const QString &note = QString(),
                    const QString &id = QString());
    bool updateRule(const QString &id, const QJsonObject &fields);
    bool removeRule(const QString &id);
    bool setDefaultAction(const QString &action);
    QString defaultAction() const { return m_default; }
    QJsonArray rules() const { return m_rules; }

    // Mirror of the engine's evaluate() — for policy.test + UI previews.
    TrustDecision evaluate(const QString &tool, const QString &app) const;

    // Short clause for the co-work preamble ("" when no rules configured).
    QString preambleClause() const;

    QString lastError() const { return m_lastError; }

    static bool isAction(const QString &a)
    { return a == QStringLiteral("allow") || a == QStringLiteral("ask") || a == QStringLiteral("deny"); }

private:
    QString m_path;
    QString m_default = QStringLiteral("allow");
    QJsonArray m_rules;
    mutable QString m_lastError;

    static int specificity(const QJsonObject &rule);
    static bool globMatch(const QString &pattern, const QString &value,
                          Qt::CaseSensitivity cs);
};

} // namespace jarvis
