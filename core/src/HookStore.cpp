#include "jarvis/HookStore.h"

#include "jarvis/Config.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcess>
#include <QRegularExpression>
#include <QSaveFile>

namespace jarvis {

QString HookStore::configPath()
{
    return Config::configDir() + QStringLiteral("/hooks.json");
}

QStringList HookStore::events()
{
    return {QStringLiteral("PreToolUse"),  QStringLiteral("PostToolUse"),
            QStringLiteral("UserPromptSubmit"), QStringLiteral("Notification"),
            QStringLiteral("Stop"),        QStringLiteral("SubagentStop"),
            QStringLiteral("SessionStart"), QStringLiteral("SessionEnd"),
            QStringLiteral("PreCompact")};
}

bool HookStore::isEvent(const QString &name)
{
    return events().contains(name);
}

void HookStore::load()
{
    m_config = QJsonObject();
    QFile f(configPath());
    if (f.exists() && f.open(QIODevice::ReadOnly)) {
        const QJsonDocument d = QJsonDocument::fromJson(f.readAll());
        f.close();
        if (d.isObject())
            m_config = d.object();
    }
    if (!m_config.contains(QStringLiteral("hooks")))
        m_config.insert(QStringLiteral("hooks"), QJsonObject());
}

HookOutcome HookStore::run(const QString &event, const QJsonObject &input,
                           const QString &matchKey) const
{
    HookOutcome out;
    const QJsonObject hooks = m_config.value(QStringLiteral("hooks")).toObject();
    const QJsonArray groups = hooks.value(event).toArray();
    if (groups.isEmpty())
        return out;

    QJsonObject payload = input;
    payload.insert(QStringLiteral("hook_event_name"), event);
    const QByteArray stdinJson = QJsonDocument(payload).toJson(QJsonDocument::Compact);

    for (const QJsonValue &gv : groups) {
        const QJsonObject group = gv.toObject();
        const QString matcher = group.value(QStringLiteral("matcher")).toString();
        // matcher filters by the event's key — tool name (Pre/PostToolUse),
        // source (SessionStart/End), notification type, or agent type
        // (SubagentStop). Only applied when the caller supplied a matchKey AND a
        // matcher; "*"/empty always fires. Treated as a regex (covers exact +
        // a|b lists).
        if (!matcher.isEmpty() && matcher != QStringLiteral("*") && !matchKey.isEmpty()) {
            const QRegularExpression re(matcher);
            if (!re.isValid() || !re.match(matchKey).hasMatch())
                continue;
        }
        const QJsonArray cmds = group.value(QStringLiteral("hooks")).toArray();
        for (const QJsonValue &hv : cmds) {
            const QJsonObject h = hv.toObject();
            if (h.value(QStringLiteral("type")).toString(QStringLiteral("command"))
                != QStringLiteral("command"))
                continue;
            const QString command = h.value(QStringLiteral("command")).toString();
            if (command.isEmpty())
                continue;
            const int timeout = h.value(QStringLiteral("timeout")).toInt(60);
            runOne(command, timeout, stdinJson, out, event);
        }
    }
    return out;
}

void HookStore::runOne(const QString &command, int timeoutSec,
                       const QByteArray &stdinJson, HookOutcome &out,
                       const QString &label) const
{
    if (timeoutSec <= 0)
        timeoutSec = 60;
    QProcess proc;
    proc.start(QStringLiteral("sh"), {QStringLiteral("-c"), command});
    if (!proc.waitForStarted(3000)) {
        out.notes << (label + QStringLiteral(": failed to start hook"));
        return;
    }
    out.ranAny = true;
    proc.write(stdinJson);
    proc.closeWriteChannel();
    if (!proc.waitForFinished(timeoutSec * 1000)) {
        proc.kill();
        proc.waitForFinished(1000);
        out.notes << (label + QStringLiteral(": TIMEOUT after ") +
                      QString::number(timeoutSec) + QStringLiteral("s"));
        return;
    }
    const int code = proc.exitCode();
    const QString sout = QString::fromUtf8(proc.readAllStandardOutput()).trimmed();
    const QString serr = QString::fromUtf8(proc.readAllStandardError()).trimmed();

    if (code == 2) {
        out.blocked = true;
        if (!serr.isEmpty())
            out.blockReason += (out.blockReason.isEmpty() ? QString() : QStringLiteral("\n")) + serr;
        out.notes << (label + QStringLiteral(": BLOCK (exit 2)"));
        return;
    }
    if (code != 0) {
        out.notes << (label + QStringLiteral(": non-blocking error (exit ") +
                      QString::number(code) + QStringLiteral(") ") + serr);
        return;
    }

    // exit 0 — structured JSON stdout wins; otherwise plain stdout is context.
    bool parsed = false;
    if (sout.startsWith(QLatin1Char('{'))) {
        const QJsonDocument d = QJsonDocument::fromJson(sout.toUtf8());
        if (d.isObject()) {
            parsed = true;
            const QJsonObject o = d.object();
            if (o.value(QStringLiteral("continue")).isBool() &&
                !o.value(QStringLiteral("continue")).toBool()) {
                out.blocked = true;
                const QString reason = o.value(QStringLiteral("stopReason"))
                                           .toString(QStringLiteral("hook requested stop"));
                out.blockReason += (out.blockReason.isEmpty() ? QString()
                                                                : QStringLiteral("\n")) + reason;
            }
            if (o.value(QStringLiteral("decision")).toString() == QStringLiteral("block")) {
                out.blocked = true;
                const QString reason = o.value(QStringLiteral("reason")).toString();
                out.blockReason += (out.blockReason.isEmpty() ? QString()
                                                                : QStringLiteral("\n")) + reason;
            }
            const QJsonObject hso = o.value(QStringLiteral("hookSpecificOutput")).toObject();
            if (hso.value(QStringLiteral("permissionDecision")).toString()
                == QStringLiteral("deny")) {
                out.blocked = true;
                const QString reason = hso.value(QStringLiteral("permissionDecisionReason")).toString();
                out.blockReason += (out.blockReason.isEmpty() ? QString()
                                                                : QStringLiteral("\n")) + reason;
            }
            QString ctx = o.value(QStringLiteral("additionalContext")).toString();
            if (ctx.isEmpty())
                ctx = hso.value(QStringLiteral("additionalContext")).toString();
            if (!ctx.isEmpty())
                out.injectedContext += (out.injectedContext.isEmpty() ? QString()
                                                                       : QStringLiteral("\n")) + ctx;
            out.notes << (label + QStringLiteral(": ok (json)"));
        }
    }
    if (!parsed) {
        if (!sout.isEmpty()) {
            out.injectedContext += (out.injectedContext.isEmpty() ? QString()
                                                                  : QStringLiteral("\n")) + sout;
        }
        out.notes << (label + QStringLiteral(": ok"));
    }
}

bool HookStore::addHook(const QString &event, const QString &matcher,
                        const QString &command, int timeoutSec)
{
    if (!isEvent(event) || command.trimmed().isEmpty()) {
        m_lastError = QStringLiteral("bad event or empty command");
        return false;
    }
    QJsonObject hooks = m_config.value(QStringLiteral("hooks")).toObject();
    QJsonArray groups = hooks.value(event).toArray();

    QJsonObject cmd;
    cmd.insert(QStringLiteral("type"), QStringLiteral("command"));
    cmd.insert(QStringLiteral("command"), command);
    if (timeoutSec > 0)
        cmd.insert(QStringLiteral("timeout"), timeoutSec);
    QJsonArray cmds;
    cmds.append(cmd);

    QJsonObject group;
    if (!matcher.isEmpty())
        group.insert(QStringLiteral("matcher"), matcher);
    group.insert(QStringLiteral("hooks"), cmds);
    groups.append(group);

    hooks.insert(event, groups);
    m_config.insert(QStringLiteral("hooks"), hooks);
    return save();
}

bool HookStore::removeHook(const QString &event, int index)
{
    QJsonObject hooks = m_config.value(QStringLiteral("hooks")).toObject();
    QJsonArray groups = hooks.value(event).toArray();
    if (index < 0 || index >= groups.size()) {
        m_lastError = QStringLiteral("index out of range");
        return false;
    }
    groups.removeAt(index);
    if (groups.isEmpty())
        hooks.remove(event);
    else
        hooks.insert(event, groups);
    m_config.insert(QStringLiteral("hooks"), hooks);
    return save();
}

bool HookStore::setConfig(const QJsonObject &config)
{
    QJsonObject c = config;
    if (!c.contains(QStringLiteral("hooks")))
        c.insert(QStringLiteral("hooks"), QJsonObject());
    m_config = c;
    return save();
}

bool HookStore::save() const
{
    const QString path = configPath();
    const QFileInfo fi(path);
    QDir dir = fi.absoluteDir();
    if (!dir.exists() && !dir.mkpath(QStringLiteral("."))) {
        m_lastError = QStringLiteral("failed to create config dir");
        return false;
    }
    QSaveFile sf(path);
    if (!sf.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_lastError = QStringLiteral("cannot write hooks.json: ") + sf.errorString();
        return false;
    }
    sf.write(QJsonDocument(m_config).toJson(QJsonDocument::Indented));
    if (!sf.commit()) {
        m_lastError = QStringLiteral("cannot commit hooks.json: ") + sf.errorString();
        return false;
    }
    return true;
}

} // namespace jarvis
