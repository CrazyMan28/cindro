#include "jarvis/CommandStore.h"
#include "jarvis/DataPaths.h"
#include "jarvis/FrontmatterUtil.h"

#include <QDir>
#include <QFile>
#include <QTextStream>

namespace jarvis {

namespace {
const QStringList kBuiltins = {
    QStringLiteral("new"), QStringLiteral("stop"), QStringLiteral("goal"),
    QStringLiteral("y"), QStringLiteral("n"), QStringLiteral("canvas"),
    QStringLiteral("widgets"), QStringLiteral("phone"), QStringLiteral("memory"),
    QStringLiteral("skills"), QStringLiteral("agents"), QStringLiteral("queue"),
    QStringLiteral("settings"), QStringLiteral("schedules"), QStringLiteral("mcp"),
    QStringLiteral("plugins"), QStringLiteral("ssh"), QStringLiteral("replay"),
    QStringLiteral("activity"), QStringLiteral("browser"), QStringLiteral("computer"),
    QStringLiteral("home"), QStringLiteral("tui"),
};
const QStringList kKinds = {QStringLiteral("mcp_tool"), QStringLiteral("shell"),
                            QStringLiteral("prompt")};
}

CommandStore::CommandStore(const QString &dir)
    : m_dir(dir.isEmpty() ? defaultDir() : dir)
{
    QDir().mkpath(m_dir);
}

QString CommandStore::defaultDir() { return jarvis::dataDir() + QStringLiteral("/commands"); }
bool CommandStore::isBuiltinName(const QString &name) { return kBuiltins.contains(name); }
bool CommandStore::isValidActionKind(const QString &kind) { return kKinds.contains(kind); }

QString CommandStore::commandDir(const QString &name) const { return m_dir + QStringLiteral("/") + name; }

QVector<CommandRow> CommandStore::list() const
{
    QVector<CommandRow> out;
    QDir root(m_dir);
    for (const auto &entry : root.entryList(QDir::Dirs | QDir::NoDotAndDotDot)) {
        if (auto row = get(entry))
            out.push_back(*row);
    }
    return out;
}

std::optional<CommandRow> CommandStore::get(const QString &name) const
{
    QFile f(commandDir(name) + QStringLiteral("/COMMAND.md"));
    if (!f.open(QIODevice::ReadOnly))
        return std::nullopt;
    const QString content = QString::fromUtf8(f.readAll());
    const auto [front, body] = splitFrontmatter(content);   // from FrontmatterUtil.h
    const auto fm = parseFlatFrontmatter(front);
    CommandRow row;
    row.name = name;
    row.description = fm.value(QStringLiteral("description"));
    row.actionKind = fm.value(QStringLiteral("action_kind"));
    row.actionTarget = fm.value(QStringLiteral("action_target"));
    row.selfAuthored = fm.value(QStringLiteral("self_authored")) == QStringLiteral("true");
    row.body = body;
    return row;
}

bool CommandStore::create(const QString &name, const QString &description,
                          const QString &actionKind, const QString &actionTarget,
                          const QString &body, bool selfAuthored)
{
    if (isBuiltinName(name) || !isValidActionKind(actionKind))
        return false;
    if (get(name).has_value())
        return false;
    QDir().mkpath(commandDir(name));
    QFile f(commandDir(name) + QStringLiteral("/COMMAND.md"));
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    QMap<QString, QString> fm;
    fm[QStringLiteral("description")] = description;
    fm[QStringLiteral("action_kind")] = actionKind;
    fm[QStringLiteral("action_target")] = actionTarget;
    fm[QStringLiteral("self_authored")] = selfAuthored ? QStringLiteral("true") : QStringLiteral("false");
    QTextStream out(&f);
    out << writeFlatFrontmatter(fm) << "\n" << body;
    return true;
}

bool CommandStore::remove(const QString &name)
{
    if (!get(name).has_value())
        return false;
    return QDir(commandDir(name)).removeRecursively();
}

} // namespace jarvis
