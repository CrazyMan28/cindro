#include "jarvis/AgentStore.h"

#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>

namespace jarvis {

namespace {

QStringList splitInlineList(const QString &raw)
{
    // Accept either `[a, b, c]` or `a, b, c` or a single token.
    QString s = raw.trimmed();
    if (s.startsWith(QLatin1Char('[')) && s.endsWith(QLatin1Char(']')))
        s = s.mid(1, s.size() - 2);
    QStringList out;
    for (const QString &part : s.split(QLatin1Char(','), Qt::SkipEmptyParts)) {
        QString t = part.trimmed();
        if ((t.startsWith(QLatin1Char('"')) && t.endsWith(QLatin1Char('"'))) ||
            (t.startsWith(QLatin1Char('\'')) && t.endsWith(QLatin1Char('\''))))
            t = t.mid(1, t.size() - 2);
        if (!t.isEmpty())
            out << t;
    }
    return out;
}

QString unquote(const QString &raw)
{
    QString t = raw.trimmed();
    if ((t.startsWith(QLatin1Char('"')) && t.endsWith(QLatin1Char('"'))) ||
        (t.startsWith(QLatin1Char('\'')) && t.endsWith(QLatin1Char('\''))))
        return t.mid(1, t.size() - 2);
    return t;
}

} // namespace

QJsonObject AgentFrontmatter::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("description"), description);
    o.insert(QStringLiteral("when_to_use"), whenToUse);
    o.insert(QStringLiteral("brain"), brain);
    o.insert(QStringLiteral("model"), model);
    o.insert(QStringLiteral("profile"), profile);
    QJsonArray t;
    for (const QString &tool : tools)
        t.append(tool);
    o.insert(QStringLiteral("tools"), t);
    o.insert(QStringLiteral("color"), color);
    for (auto it = extra.begin(); it != extra.end(); ++it)
        o.insert(it.key(), it.value());
    return o;
}

QJsonObject AgentRow::toListJson() const
{
    QJsonObject o = fm.toJson();
    o.insert(QStringLiteral("path"), path);
    o.insert(QStringLiteral("system_prompt"), systemPrompt);
    return o;
}

QString AgentStore::defaultRoot()
{
    return QDir::homePath() + QStringLiteral("/.local/share/jarvis/agents");
}

QString AgentStore::claudeAgentsRoot()
{
    return QDir::homePath() + QStringLiteral("/.claude/agents");
}

QString AgentStore::root() const
{
    return m_root.isEmpty() ? defaultRoot() : m_root;
}

QString AgentStore::slug(const QString &name)
{
    QString out;
    for (const QChar &ch : name) {
        if (ch.isLetterOrNumber())
            out.append(ch.toLower());
        else if (ch == QLatin1Char('-') || ch == QLatin1Char('_'))
            out.append(ch);
        else if (ch.isSpace() || ch == QLatin1Char('/'))
            out.append(QLatin1Char('-'));
    }
    while (out.contains(QStringLiteral("--")))
        out.replace(QStringLiteral("--"), QStringLiteral("-"));
    if (out.isEmpty())
        out = QStringLiteral("agent");
    return out;
}

bool AgentStore::parse(const QString &text, AgentFrontmatter *fmOut, QString *bodyOut)
{
    AgentFrontmatter fm;
    QString body = text;

    const QStringList lines = text.split(QLatin1Char('\n'));
    if (!lines.isEmpty() && lines.first().trimmed() == QStringLiteral("---")) {
        int close = -1;
        for (int i = 1; i < lines.size(); ++i) {
            if (lines[i].trimmed() == QStringLiteral("---")) {
                close = i;
                break;
            }
        }
        if (close > 0) {
            for (int i = 1; i < close; ++i) {
                const QString &line = lines[i];
                const int colon = line.indexOf(QLatin1Char(':'));
                if (colon < 0)
                    continue;
                const QString key = line.left(colon).trimmed();
                const QString val = line.mid(colon + 1).trimmed();
                if (key == QStringLiteral("name"))
                    fm.name = unquote(val);
                else if (key == QStringLiteral("description"))
                    fm.description = unquote(val);
                else if (key == QStringLiteral("when_to_use") ||
                         key == QStringLiteral("whenToUse"))
                    fm.whenToUse = unquote(val);
                else if (key == QStringLiteral("brain"))
                    fm.brain = unquote(val).toLower();
                else if (key == QStringLiteral("model"))
                    fm.model = unquote(val);
                else if (key == QStringLiteral("profile"))
                    fm.profile = unquote(val).toLower();
                else if (key == QStringLiteral("tools"))
                    fm.tools = splitInlineList(val);
                else if (key == QStringLiteral("color"))
                    fm.color = unquote(val);
                else if (!key.isEmpty())
                    fm.extra.insert(key, unquote(val));
            }
            QStringList bodyLines;
            for (int i = close + 1; i < lines.size(); ++i)
                bodyLines << lines[i];
            body = bodyLines.join(QLatin1Char('\n'));
            if (body.startsWith(QLatin1Char('\n')))
                body.remove(0, 1);
        }
    }

    if (fmOut)
        *fmOut = fm;
    if (bodyOut)
        *bodyOut = body;
    return true;
}

QString AgentStore::serialize(const AgentFrontmatter &fm, const QString &body)
{
    QString out = QStringLiteral("---\n");
    out += QStringLiteral("name: %1\n").arg(fm.name);
    out += QStringLiteral("description: %1\n").arg(fm.description);
    if (!fm.whenToUse.isEmpty())
        out += QStringLiteral("when_to_use: %1\n").arg(fm.whenToUse);
    if (!fm.brain.isEmpty())
        out += QStringLiteral("brain: %1\n").arg(fm.brain);
    if (!fm.model.isEmpty())
        out += QStringLiteral("model: %1\n").arg(fm.model);
    if (!fm.profile.isEmpty())
        out += QStringLiteral("profile: %1\n").arg(fm.profile);
    if (!fm.tools.isEmpty())
        out += QStringLiteral("tools: [%1]\n").arg(fm.tools.join(QStringLiteral(", ")));
    if (!fm.color.isEmpty())
        out += QStringLiteral("color: %1\n").arg(fm.color);
    out += QStringLiteral("---\n\n");
    out += body;
    if (!body.endsWith(QLatin1Char('\n')))
        out += QLatin1Char('\n');
    return out;
}

QString AgentStore::serializeClaude(const AgentFrontmatter &fm, const QString &body)
{
    // Claude-Code subagent format: name (slug), description, optional tools/model.
    QString out = QStringLiteral("---\n");
    out += QStringLiteral("name: %1\n").arg(slug(fm.name));
    QString desc = fm.description;
    if (!fm.whenToUse.isEmpty())
        desc = desc.isEmpty() ? fm.whenToUse
                              : (desc + QStringLiteral(" — ") + fm.whenToUse);
    out += QStringLiteral("description: %1\n").arg(desc);
    if (!fm.tools.isEmpty())
        out += QStringLiteral("tools: %1\n").arg(fm.tools.join(QStringLiteral(", ")));
    if (!fm.model.isEmpty())
        out += QStringLiteral("model: %1\n").arg(fm.model);
    out += QStringLiteral("---\n\n");
    out += body;
    if (!body.endsWith(QLatin1Char('\n')))
        out += QLatin1Char('\n');
    return out;
}

QVector<AgentRow> AgentStore::list()
{
    QVector<AgentRow> out;
    QDir dir(root());
    if (!dir.exists())
        return out;

    QDirIterator it(root(), QStringList{QStringLiteral("AGENT.md")}, QDir::Files,
                    QDirIterator::Subdirectories);
    while (it.hasNext()) {
        const QString path = it.next();
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
            continue;
        const QString text = QString::fromUtf8(f.readAll());
        f.close();
        AgentFrontmatter fm;
        QString body;
        parse(text, &fm, &body);
        const QDir agentDir = QFileInfo(path).absoluteDir();
        if (fm.name.isEmpty())
            fm.name = agentDir.dirName();
        if (fm.profile.isEmpty())
            fm.profile = QStringLiteral("coworker");
        AgentRow row;
        row.fm = fm;
        row.systemPrompt = body;
        row.path = path;
        out.push_back(row);
    }

    std::sort(out.begin(), out.end(), [](const AgentRow &a, const AgentRow &b) {
        return a.fm.name.toLower() < b.fm.name.toLower();
    });
    return out;
}

std::optional<AgentRow> AgentStore::get(const QString &name)
{
    const QString want = name.trimmed();
    const QString wantSlug = slug(want);
    for (const AgentRow &row : list()) {
        if (row.fm.name.compare(want, Qt::CaseInsensitive) == 0)
            return row;
        const QString dirName = QFileInfo(row.path).absoluteDir().dirName();
        if (dirName.compare(wantSlug, Qt::CaseInsensitive) == 0 ||
            dirName.compare(want, Qt::CaseInsensitive) == 0)
            return row;
    }
    return std::nullopt;
}

bool AgentStore::read(const QString &name, AgentFrontmatter *fmOut, QString *bodyOut,
                      QString *pathOut)
{
    auto row = get(name);
    if (!row) {
        m_lastError = QStringLiteral("no such agent: ") + name;
        return false;
    }
    if (fmOut)
        *fmOut = row->fm;
    if (bodyOut)
        *bodyOut = row->systemPrompt;
    if (pathOut)
        *pathOut = row->path;
    return true;
}

QString AgentStore::create(const QString &name, const QString &description,
                           const QString &whenToUse, const QString &systemPrompt,
                           const QString &brain, const QString &model,
                           const QString &profile, const QStringList &tools,
                           const QString &color)
{
    if (name.trimmed().isEmpty()) {
        m_lastError = QStringLiteral("agent name is required");
        return QString();
    }
    const QString nm = slug(name);
    const QString agentDirPath = root() + QStringLiteral("/") + nm;
    QDir().mkpath(agentDirPath);

    AgentFrontmatter fm;
    fm.name = name.trimmed();
    fm.description = description.trimmed();
    fm.whenToUse = whenToUse.trimmed();
    fm.brain = brain.trimmed().toLower();
    fm.model = model.trimmed();
    fm.profile = profile.trimmed().toLower().isEmpty() ? QStringLiteral("coworker")
                                                       : profile.trimmed().toLower();
    fm.tools = tools;
    fm.color = color.trimmed();

    const QString md = serialize(fm, systemPrompt);
    const QString mdPath = agentDirPath + QStringLiteral("/AGENT.md");
    {
        QFile f(mdPath);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Text)) {
            m_lastError = QStringLiteral("cannot write agent: ") + mdPath;
            return QString();
        }
        f.write(md.toUtf8());
        f.close();
    }

    // Mirror into ~/.claude/agents so the claude CLI brain picks it up.
    mirrorToCli(nm, serializeClaude(fm, systemPrompt));

    return mdPath;
}

void AgentStore::mirrorToCli(const QString &name, const QString &md)
{
    const QString cliRoot = claudeAgentsRoot();
    // Only mirror if ~/.claude already exists (i.e. the CLI is installed/used) —
    // never create ~/.claude ourselves.
    const QFileInfo parent(QFileInfo(cliRoot).absolutePath());
    if (!parent.exists())
        return;
    if (!QDir().mkpath(cliRoot))
        return;
    QFile f(cliRoot + QStringLiteral("/") + name + QStringLiteral(".md"));
    if (f.open(QIODevice::WriteOnly | QIODevice::Text)) {
        f.write(md.toUtf8());
        f.close();
    }
}

bool AgentStore::remove(const QString &name)
{
    auto row = get(name);
    if (!row) {
        m_lastError = QStringLiteral("no such agent: ") + name;
        return false;
    }
    QDir agentDir = QFileInfo(row->path).absoluteDir();
    if (!agentDir.removeRecursively()) {
        m_lastError = QStringLiteral("failed to remove agent dir: ") +
                      agentDir.absolutePath();
        return false;
    }
    // Best-effort: remove the claude mirror too.
    QFile::remove(claudeAgentsRoot() + QStringLiteral("/") +
                  slug(row->fm.name) + QStringLiteral(".md"));
    return true;
}

} // namespace jarvis
