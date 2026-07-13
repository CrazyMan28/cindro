#include "jarvis/PhonePolicyStore.h"

#include "jarvis/Config.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSaveFile>

namespace jarvis {

namespace {

// Tri-state helpers ---------------------------------------------------------
bool isTriState(const QString &v)
{
    return v == QStringLiteral("allow") || v == QStringLiteral("ask")
        || v == QStringLiteral("deny");
}

// The static capability catalog — the single source of truth for ids, choices,
// defaults, enforcement badges, and UI labels. Order here is the UI order.
QVector<PhoneCapability> buildCatalog()
{
    const QStringList triState{QStringLiteral("allow"), QStringLiteral("ask"),
                               QStringLiteral("deny")};
    const QVector<QPair<QString, QString>> triLabels{
        {QStringLiteral("allow"), QStringLiteral("Allow")},
        {QStringLiteral("ask"), QStringLiteral("Ask first")},
        {QStringLiteral("deny"), QStringLiteral("Deny")}};

    QVector<PhoneCapability> c;

    c.append({QStringLiteral("answer_calls"),
              QStringLiteral("Answer incoming calls"),
              {QStringLiteral("allowed_only"), QStringLiteral("screen_unknown")},
              {{QStringLiteral("allowed_only"), QStringLiteral("Allowed numbers only")},
               {QStringLiteral("screen_unknown"), QStringLiteral("Screen unknown callers")}},
              QStringLiteral("screen_unknown"),
              QStringLiteral("config"),
              QStringLiteral("Who Cindro answers when your number is called. Enforced by driving "
                             "call screening: 'screen_unknown' screens unknown callers (allow-listed "
                             "numbers answered directly); 'allowed_only' rejects anyone not on the "
                             "phone-number allowlist.")});

    c.append({QStringLiteral("send_sms"), QStringLiteral("Send texts (SMS)"),
              triState, triLabels, QStringLiteral("ask"), QStringLiteral("hard"),
              QStringLiteral("Whether Cindro may send SMS on your behalf.")});

    c.append({QStringLiteral("outbound_calls"),
              QStringLiteral("Place outbound calls"), triState, triLabels,
              QStringLiteral("allow"), QStringLiteral("hard"),
              QStringLiteral("Whether Cindro may place calls (in-app or PSTN).")});

    c.append({QStringLiteral("spend_money"),
              QStringLiteral("Billable actions (PSTN calls/SMS)"), triState,
              triLabels, QStringLiteral("ask"), QStringLiteral("hard"),
              QStringLiteral("Extra gate on anything that costs money via Twilio. "
                             "Applied as the STRICTER of this and the per-action rule.")});

    c.append({QStringLiteral("access_memory"),
              QStringLiteral("Read/write memory"), triState, triLabels,
              QStringLiteral("allow"), QStringLiteral("hard"),
              QStringLiteral("Whether Cindro may store or search memories during a call/text.")});

    c.append({QStringLiteral("computer_use_on_call"),
              QStringLiteral("Use the computer during a call"), triState,
              triLabels, QStringLiteral("deny"), QStringLiteral("soft"),
              QStringLiteral("GUIDANCE ONLY — the inbound call agent runs in the vendored "
                             "phone server with no daemon choke point, so this steers it "
                             "via its prompt, it is not hard-blocked.")});

    c.append({QStringLiteral("access_files"),
              QStringLiteral("Read files during a call"), triState, triLabels,
              QStringLiteral("ask"), QStringLiteral("soft"),
              QStringLiteral("GUIDANCE ONLY — same vendored-agent boundary as "
                             "'Use the computer during a call'.")});

    return c;
}

// tool -> gating tri-state capability ids. PSTN/billed tools also map to
// spend_money so decisionForTool takes the stricter of the two. Only tri-state
// capabilities appear here (answer_calls is config-driven, not a tool gate).
QHash<QString, QStringList> buildToolMap()
{
    QHash<QString, QStringList> m;
    // SMS
    m.insert(QStringLiteral("twilio_sms"),
             {QStringLiteral("send_sms"), QStringLiteral("spend_money")});
    m.insert(QStringLiteral("device_sms"), {QStringLiteral("send_sms")});
    // Outbound calls
    m.insert(QStringLiteral("twilio_call_and_wait"),
             {QStringLiteral("outbound_calls"), QStringLiteral("spend_money")});
    m.insert(QStringLiteral("call_user"), {QStringLiteral("outbound_calls")});
    m.insert(QStringLiteral("call_user_and_wait"), {QStringLiteral("outbound_calls")});
    m.insert(QStringLiteral("call_extension"), {QStringLiteral("outbound_calls")});
    // Memory
    m.insert(QStringLiteral("store_memory"), {QStringLiteral("access_memory")});
    m.insert(QStringLiteral("search_memory"), {QStringLiteral("access_memory")});
    return m;
}

} // namespace

const QVector<PhoneCapability> &PhonePolicyStore::catalog()
{
    static const QVector<PhoneCapability> kCatalog = buildCatalog();
    return kCatalog;
}

const PhoneCapability *PhonePolicyStore::capability(const QString &id)
{
    for (const PhoneCapability &c : catalog())
        if (c.id == id)
            return &c;
    return nullptr;
}

bool PhonePolicyStore::isValidValue(const QString &capId, const QString &value)
{
    const PhoneCapability *c = capability(capId);
    return c && c->choices.contains(value);
}

QStringList PhonePolicyStore::capabilitiesForTool(const QString &toolName)
{
    static const QHash<QString, QStringList> kToolMap = buildToolMap();
    return kToolMap.value(toolName);
}

int PhonePolicyStore::strictness(const QString &triState)
{
    if (triState == QStringLiteral("deny"))
        return 2;
    if (triState == QStringLiteral("ask"))
        return 1;
    return 0; // allow / unknown
}

PhonePolicyStore::PhonePolicyStore(const QString &root)
{
    const QString dir = root.isEmpty() ? Config::configDir() : root;
    m_path = dir + QStringLiteral("/phone_policy.json");
    load();
}

void PhonePolicyStore::load()
{
    // Start from defaults so a missing key always resolves to a sane value.
    m_values = QJsonObject();
    for (const PhoneCapability &c : catalog())
        m_values.insert(c.id, c.defaultValue);

    QFile f(m_path);
    if (!f.open(QIODevice::ReadOnly))
        return; // no file yet = all defaults
    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
    if (!doc.isObject())
        return; // corrupt file must never brick the daemon
    const QJsonObject caps = doc.object().value(QStringLiteral("capabilities")).toObject();
    for (const PhoneCapability &c : catalog()) {
        const QString v = caps.value(c.id).toString();
        if (isValidValue(c.id, v)) // ignore unknown/invalid values
            m_values.insert(c.id, v);
    }
}

QJsonObject PhonePolicyStore::valuesJson() const
{
    QJsonObject caps;
    for (const PhoneCapability &c : catalog())
        caps.insert(c.id, value(c.id));
    return caps;
}

bool PhonePolicyStore::save() const
{
    QDir().mkpath(QFileInfo(m_path).absolutePath());
    QSaveFile f(m_path);
    if (!f.open(QIODevice::WriteOnly)) {
        m_lastError = QStringLiteral("cannot write ") + m_path;
        return false;
    }
    QJsonObject obj;
    obj.insert(QStringLiteral("version"), 1);
    obj.insert(QStringLiteral("capabilities"), valuesJson());
    f.write(QJsonDocument(obj).toJson(QJsonDocument::Indented));
    if (!f.commit()) {
        m_lastError = QStringLiteral("commit failed for ") + m_path;
        return false;
    }
    return true;
}

QJsonObject PhonePolicyStore::toJson() const
{
    QJsonArray caps;
    for (const PhoneCapability &c : catalog()) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), c.id);
        o.insert(QStringLiteral("label"), c.label);
        o.insert(QStringLiteral("value"), value(c.id));
        o.insert(QStringLiteral("default"), c.defaultValue);
        o.insert(QStringLiteral("enforcement"), c.enforcement);
        o.insert(QStringLiteral("note"), c.note);
        QJsonArray choices;
        for (const QString &ch : c.choices)
            choices.append(ch);
        o.insert(QStringLiteral("choices"), choices);
        QJsonArray labels;
        for (const auto &pair : c.choiceLabels) {
            QJsonObject l;
            l.insert(QStringLiteral("value"), pair.first);
            l.insert(QStringLiteral("label"), pair.second);
            labels.append(l);
        }
        o.insert(QStringLiteral("choiceLabels"), labels);
        caps.append(o);
    }
    QJsonObject obj;
    obj.insert(QStringLiteral("version"), 1);
    obj.insert(QStringLiteral("capabilities"), caps);
    return obj;
}

QString PhonePolicyStore::value(const QString &capId) const
{
    const QString v = m_values.value(capId).toString();
    if (isValidValue(capId, v))
        return v;
    const PhoneCapability *c = capability(capId);
    return c ? c->defaultValue : QString();
}

bool PhonePolicyStore::setValue(const QString &capId, const QString &value)
{
    if (!capability(capId)) {
        m_lastError = QStringLiteral("unknown capability: ") + capId;
        return false;
    }
    if (!isValidValue(capId, value)) {
        m_lastError = QStringLiteral("invalid value '") + value
                    + QStringLiteral("' for ") + capId;
        return false;
    }
    m_values.insert(capId, value);
    return save();
}

bool PhonePolicyStore::reset()
{
    m_values = QJsonObject();
    for (const PhoneCapability &c : catalog())
        m_values.insert(c.id, c.defaultValue);
    return save();
}

QString PhonePolicyStore::decisionForTool(const QString &phoneToolName) const
{
    const QStringList caps = capabilitiesForTool(phoneToolName);
    if (caps.isEmpty())
        return QStringLiteral("allow"); // ungated tool
    QString worst = QStringLiteral("allow");
    for (const QString &capId : caps) {
        const QString v = value(capId);
        if (isTriState(v) && strictness(v) > strictness(worst))
            worst = v;
    }
    return worst;
}

} // namespace jarvis
