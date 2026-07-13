#pragma once

// PhonePolicyStore — phone-scoped capability policy ("what Cindro may do over
// the phone").
//
// The daemon-side owner of ~/.config/jarvis/phone_policy.json. Unlike
// TrustPolicyStore (glob rules over arbitrary tools/apps), this is a FIXED
// capability map: a small, closed set of phone capabilities, each set to one of
// a closed choice list. That deliberate difference is because the phone surface
// has a known, bounded set of powers, and the UI renders one card per
// capability with an honest "Enforced" vs "Guidance" badge.
//
//   { "version": 1,
//     "capabilities": {
//       "answer_calls":         "screen_unknown",  // allowed_only|screen_unknown
//       "send_sms":             "ask",             // allow|ask|deny
//       "outbound_calls":       "allow",
//       "spend_money":          "ask",
//       "access_memory":        "allow",
//       "computer_use_on_call": "deny",
//       "access_files":         "ask"
//     } }
//
// ENFORCEMENT (see docs/PHONE.md + AGENTS.md): the tri-state capabilities that
// map to phone MCP tools (send_sms/outbound_calls/spend_money/access_memory) are
// HARD-gated at the daemon's phone.mcp choke point (deny) + the computer-use
// policy gate (ask). answer_calls is HARD via config (screening/allowlist).
// computer_use_on_call/access_files gate the INBOUND (vendored-server) agent and
// are SOFT only — preamble guidance, not a daemon choke point.

#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>

namespace jarvis {

// One phone capability the user can tune. `enforcement` is surfaced in the UI:
//   "hard"   — blocked/asked at a daemon/engine choke point Cindro owns
//   "config" — enforced by driving the phone server's own config (screening/allowlist)
//   "soft"   — guidance only (the vendored inbound agent has no daemon choke point)
struct PhoneCapability {
    QString id;
    QString label;
    QStringList choices;                 // ordered, valid values for this capability
    QVector<QPair<QString, QString>> choiceLabels;  // value -> human label (ordered)
    QString defaultValue;
    QString enforcement;                 // "hard" | "config" | "soft"
    QString note;
};

class PhonePolicyStore {
public:
    // Default: ~/.config/jarvis/phone_policy.json. A non-empty `root` makes a
    // store on <root>/phone_policy.json (unit tests) — same convention as
    // TrustPolicyStore, honoring JARVIS_CONFIG_DIR profiles.
    explicit PhonePolicyStore(const QString &root = QString());

    QString filePath() const { return m_path; }

    // (Re)load from disk. Missing/corrupt file => all defaults (never bricks).
    void load();
    bool save() const;

    // The whole config, ENRICHED for phone.policy.list / UI:
    //   { version, capabilities:[{id,label,value,choices,choiceLabels,enforcement,note}] }
    QJsonObject toJson() const;

    // Current value for a capability (its default when unset/invalid).
    QString value(const QString &capId) const;

    // Set + persist. Rejects an unknown capability or a value outside its
    // choices. Returns false (with lastError set) on rejection or write failure.
    bool setValue(const QString &capId, const QString &value);

    // Restore every capability to its default + persist.
    bool reset();

    // True when a phone MCP tool is gated by at least one capability (i.e. it
    // appears in the static tool->capability table). Ungated tools are always
    // allowed and never consulted.
    static bool isGatedTool(const QString &toolName)
    { return !capabilitiesForTool(toolName).isEmpty(); }

    // Map a phone MCP tool name to a tri-state decision (allow|ask|deny) by
    // consulting the static tool->capability table and returning the STRICTEST
    // (deny > ask > allow) among the gating capabilities. A tool with no gating
    // capability returns "allow". This is what the daemon phone.mcp choke point
    // and the computer-use gate both consult.
    QString decisionForTool(const QString &phoneToolName) const;

    QString lastError() const { return m_lastError; }

    // ---- static catalog (also used by the daemon + tests) --------------------
    static const QVector<PhoneCapability> &catalog();
    static const PhoneCapability *capability(const QString &id);
    static bool isValidValue(const QString &capId, const QString &value);
    // The tri-state capability ids that gate a given phone MCP tool ("" list =
    // ungated). answer_calls is NOT here (it is config-driven, not a tool gate).
    static QStringList capabilitiesForTool(const QString &toolName);

private:
    QString m_path;
    QJsonObject m_values;       // capId -> value (full effective map after load)
    mutable QString m_lastError;

    QJsonObject valuesJson() const;             // compact persisted {capId:value}
    static int strictness(const QString &triState);  // allow=0 < ask=1 < deny=2
};

} // namespace jarvis
