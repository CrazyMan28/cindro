#include "jarvis/TrustPolicyStore.h"

#include "jarvis/Config.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>
#include <QUuid>

namespace jarvis {

TrustPolicyStore::TrustPolicyStore(const QString &root)
{
    // Config::configDir() (not QStandardPaths) so this store honors
    // JARVIS_CONFIG_DIR profiles and never diverges from the other config
    // stores when XDG_CONFIG_HOME is set (jarvis#76 item 15).
    const QString dir = root.isEmpty() ? Config::configDir() : root;
    m_path = dir + QStringLiteral("/trust_policies.json");
    // MIGRATION: this store previously resolved via QStandardPaths, which
    // honors XDG_CONFIG_HOME — a user with that set had their rules at the
    // OLD location. Silently abandoning them would reset the policy engine
    // to allow-everything, so adopt the legacy file once if the new path is
    // still empty.
    if (root.isEmpty() && !QFileInfo::exists(m_path)) {
        const QString legacy =
            QStandardPaths::writableLocation(QStandardPaths::ConfigLocation)
            + QStringLiteral("/jarvis/trust_policies.json");
        if (legacy != m_path && QFileInfo::exists(legacy)) {
            QDir().mkpath(dir);
            QFile::copy(legacy, m_path);
        }
    }
    load();
}

void TrustPolicyStore::load()
{
    m_default = QStringLiteral("allow");
    m_rules = QJsonArray();
    QFile f(m_path);
    if (!f.open(QIODevice::ReadOnly))
        return; // no file yet = no policies
    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
    if (!doc.isObject())
        return; // corrupt file must never brick the daemon
    const QJsonObject obj = doc.object();
    const QString def = obj.value(QStringLiteral("default")).toString();
    if (isAction(def))
        m_default = def;
    if (obj.value(QStringLiteral("rules")).isArray())
        m_rules = obj.value(QStringLiteral("rules")).toArray();
}

QJsonObject TrustPolicyStore::toJson() const
{
    QJsonObject obj;
    obj.insert(QStringLiteral("version"), 1);
    obj.insert(QStringLiteral("default"), m_default);
    obj.insert(QStringLiteral("rules"), m_rules);
    return obj;
}

bool TrustPolicyStore::save() const
{
    QDir().mkpath(QFileInfo(m_path).absolutePath());
    QSaveFile f(m_path);
    if (!f.open(QIODevice::WriteOnly)) {
        m_lastError = QStringLiteral("cannot write ") + m_path;
        return false;
    }
    f.write(QJsonDocument(toJson()).toJson(QJsonDocument::Indented));
    if (!f.commit()) {
        m_lastError = QStringLiteral("commit failed for ") + m_path;
        return false;
    }
    return true;
}

QString TrustPolicyStore::addRule(const QString &tool, const QString &app,
                                  const QString &action, const QString &note,
                                  const QString &id)
{
    if (!isAction(action)) {
        m_lastError = QStringLiteral("bad action: ") + action;
        return QString();
    }
    const QString t = tool.trimmed().isEmpty() ? QStringLiteral("*") : tool.trimmed();
    const QString a = app.trimmed().isEmpty() ? QStringLiteral("*") : app.trimmed();
    QString rid = id.trimmed();
    if (rid.isEmpty()) {
        // Readable slug from the note/tool + a short random tail for uniqueness.
        QString base = (note.trimmed().isEmpty() ? t : note.trimmed()).toLower();
        base.replace(QRegularExpression(QStringLiteral("[^a-z0-9]+")), QStringLiteral("-"));
        base = base.left(24);
        while (base.startsWith(QLatin1Char('-'))) base.remove(0, 1);
        while (base.endsWith(QLatin1Char('-'))) base.chop(1);
        rid = (base.isEmpty() ? QStringLiteral("rule") : base) + QLatin1Char('-')
              + QUuid::createUuid().toString(QUuid::Id128).left(6);
    }
    // Ids are unique — replace any existing rule with the same id.
    removeRule(rid);
    QJsonObject r;
    r.insert(QStringLiteral("id"), rid);
    r.insert(QStringLiteral("tool"), t);
    r.insert(QStringLiteral("app"), a);
    r.insert(QStringLiteral("action"), action);
    if (!note.trimmed().isEmpty())
        r.insert(QStringLiteral("note"), note.trimmed());
    m_rules.append(r);
    return save() ? rid : QString();
}

bool TrustPolicyStore::updateRule(const QString &id, const QJsonObject &fields)
{
    for (int i = 0; i < m_rules.size(); ++i) {
        QJsonObject r = m_rules.at(i).toObject();
        if (r.value(QStringLiteral("id")).toString() != id)
            continue;
        for (auto it = fields.constBegin(); it != fields.constEnd(); ++it) {
            const QString key = it.key();
            if (key == QStringLiteral("id"))
                continue; // ids are stable
            if (key == QStringLiteral("action")
                && !isAction(it.value().toString())) {
                m_lastError = QStringLiteral("bad action");
                return false;
            }
            r.insert(key, it.value());
        }
        m_rules.replace(i, r);
        return save();
    }
    m_lastError = QStringLiteral("no rule: ") + id;
    return false;
}

bool TrustPolicyStore::removeRule(const QString &id)
{
    for (int i = 0; i < m_rules.size(); ++i) {
        if (m_rules.at(i).toObject().value(QStringLiteral("id")).toString() == id) {
            m_rules.removeAt(i);
            return save();
        }
    }
    return false;
}

bool TrustPolicyStore::setDefaultAction(const QString &action)
{
    if (!isAction(action)) {
        m_lastError = QStringLiteral("bad action: ") + action;
        return false;
    }
    m_default = action;
    return save();
}

int TrustPolicyStore::specificity(const QJsonObject &rule)
{
    int s = 0;
    for (const auto key : {QStringLiteral("tool"), QStringLiteral("app")}) {
        QString pat = rule.value(key).toString();
        if (pat.isEmpty())
            pat = QStringLiteral("*");
        for (const QChar &ch : pat)
            if (ch != QLatin1Char('*') && ch != QLatin1Char('?')
                && ch != QLatin1Char('[') && ch != QLatin1Char(']'))
                ++s;
    }
    return s;
}

bool TrustPolicyStore::globMatch(const QString &pattern, const QString &value,
                                 Qt::CaseSensitivity cs)
{
    const QRegularExpression re(
        QRegularExpression::wildcardToRegularExpression(pattern),
        cs == Qt::CaseInsensitive ? QRegularExpression::CaseInsensitiveOption
                                  : QRegularExpression::NoPatternOption);
    return re.match(value).hasMatch();
}

TrustDecision TrustPolicyStore::evaluate(const QString &tool, const QString &app) const
{
    const QJsonObject *bestPtr = nullptr;
    QJsonObject best;
    int bestSpec = -1;
    for (const QJsonValue &v : m_rules) {
        const QJsonObject r = v.toObject();
        QString tpat = r.value(QStringLiteral("tool")).toString();
        QString apat = r.value(QStringLiteral("app")).toString();
        if (tpat.isEmpty()) tpat = QStringLiteral("*");
        if (apat.isEmpty()) apat = QStringLiteral("*");
        if (!globMatch(tpat, tool, Qt::CaseSensitive))
            continue;
        if (apat != QStringLiteral("*")
            && !globMatch(apat, app, Qt::CaseInsensitive))
            continue;
        const int spec = specificity(r);
        if (spec > bestSpec) { // ties keep the EARLIEST rule
            best = r;
            bestPtr = &best;
            bestSpec = spec;
        }
    }
    TrustDecision d;
    if (!bestPtr) {
        d.action = m_default;
        return d;
    }
    const QString action = best.value(QStringLiteral("action")).toString();
    d.action = isAction(action) ? action : QStringLiteral("allow");
    d.ruleId = best.value(QStringLiteral("id")).toString();
    d.note = best.value(QStringLiteral("note")).toString();
    return d;
}

QString TrustPolicyStore::preambleClause() const
{
    if (m_rules.isEmpty() && m_default == QStringLiteral("allow"))
        return QString();
    QString out = QStringLiteral(
        "\n\nTRUST POLICIES: the user configured per-tool/per-app permission rules"
        " that are ENFORCED at the tool layer (a denied tool call fails; an 'ask'"
        " tool call pops a question the user must approve). Work WITH them:"
        " don't retry denied tools, and prefer approaches that stay inside"
        " allowed tools. Default: ");
    out += m_default + QStringLiteral(". Rules (most specific wins):");
    for (const QJsonValue &v : m_rules) {
        const QJsonObject r = v.toObject();
        out += QStringLiteral("\n- tool '") + r.value(QStringLiteral("tool")).toString()
             + QStringLiteral("' app '") + r.value(QStringLiteral("app")).toString()
             + QStringLiteral("' -> ") + r.value(QStringLiteral("action")).toString();
        const QString note = r.value(QStringLiteral("note")).toString();
        if (!note.isEmpty())
            out += QStringLiteral(" (") + note + QLatin1Char(')');
    }
    return out;
}

} // namespace jarvis
