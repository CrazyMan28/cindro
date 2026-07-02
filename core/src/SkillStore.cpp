#include "jarvis/SkillStore.h"

#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QJsonArray>
#include <QTextStream>

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

bool truthy(const QString &raw)
{
    const QString v = raw.trimmed().toLower();
    return v == QStringLiteral("true") || v == QStringLiteral("yes") ||
           v == QStringLiteral("1");
}

} // namespace

QJsonObject SkillFrontmatter::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("description"), description);
    QJsonArray t;
    for (const QString &tag : tags)
        t.append(tag);
    o.insert(QStringLiteral("tags"), t);
    o.insert(QStringLiteral("group"), group);
    o.insert(QStringLiteral("self_authored"), selfAuthored);
    for (auto it = extra.begin(); it != extra.end(); ++it)
        o.insert(it.key(), it.value());
    return o;
}

QJsonObject SkillRow::toListJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("name"), fm.name);
    o.insert(QStringLiteral("group"), fm.group);
    o.insert(QStringLiteral("description"), fm.description);
    QJsonArray t;
    for (const QString &tag : fm.tags)
        t.append(tag);
    o.insert(QStringLiteral("tags"), t);
    o.insert(QStringLiteral("self_authored"), fm.selfAuthored);
    o.insert(QStringLiteral("path"), path);
    return o;
}

QString SkillStore::defaultRoot()
{
    return QDir::homePath() + QStringLiteral("/.local/share/jarvis/skills");
}

QString SkillStore::codexSkillsRoot()
{
    return QDir::homePath() + QStringLiteral("/.codex/skills");
}

QString SkillStore::claudeSkillsRoot()
{
    return QDir::homePath() + QStringLiteral("/.claude/skills");
}

QString SkillStore::root() const
{
    return m_root.isEmpty() ? defaultRoot() : m_root;
}

QString SkillStore::slug(const QString &name)
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
        out = QStringLiteral("skill");
    return out;
}

bool SkillStore::parse(const QString &text, SkillFrontmatter *fmOut, QString *bodyOut)
{
    SkillFrontmatter fm;
    QString body = text;

    // YAML frontmatter is delimited by a leading "---" line and a closing
    // "---" line. Everything after is the body.
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
                else if (key == QStringLiteral("group"))
                    fm.group = unquote(val);
                else if (key == QStringLiteral("tags"))
                    fm.tags = splitInlineList(val);
                else if (key == QStringLiteral("self_authored") ||
                         key == QStringLiteral("authored_by"))
                    fm.selfAuthored = truthy(val) ||
                                      unquote(val).toLower() == QStringLiteral("jarvis");
                else if (!key.isEmpty())
                    fm.extra.insert(key, unquote(val));
            }
            // Body = lines after the closing delimiter.
            QStringList bodyLines;
            for (int i = close + 1; i < lines.size(); ++i)
                bodyLines << lines[i];
            body = bodyLines.join(QLatin1Char('\n'));
            // Trim a single leading blank line.
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

QString SkillStore::serialize(const SkillFrontmatter &fm, const QString &body)
{
    QString out = QStringLiteral("---\n");
    out += QStringLiteral("name: %1\n").arg(fm.name);
    out += QStringLiteral("description: %1\n").arg(fm.description);
    if (!fm.group.isEmpty())
        out += QStringLiteral("group: %1\n").arg(fm.group);
    if (!fm.tags.isEmpty())
        out += QStringLiteral("tags: [%1]\n").arg(fm.tags.join(QStringLiteral(", ")));
    if (fm.selfAuthored)
        out += QStringLiteral("self_authored: true\n");
    for (auto it = fm.extra.begin(); it != fm.extra.end(); ++it)
        out += QStringLiteral("%1: %2\n").arg(it.key(), it.value().toString());
    out += QStringLiteral("---\n\n");
    out += body;
    if (!body.endsWith(QLatin1Char('\n')))
        out += QLatin1Char('\n');
    return out;
}

QString SkillStore::renderTemplate(const QString &body, const QJsonObject &vars)
{
    QString out = body;
    for (auto it = vars.begin(); it != vars.end(); ++it) {
        const QString token = QStringLiteral("{{") + it.key() + QStringLiteral("}}");
        QString val;
        const QJsonValue v = it.value();
        if (v.isString())
            val = v.toString();
        else if (v.isDouble())
            val = QString::number(v.toDouble());
        else if (v.isBool())
            val = v.toBool() ? QStringLiteral("true") : QStringLiteral("false");
        out.replace(token, val);
    }
    return out;
}

QVector<SkillRow> SkillStore::list()
{
    QVector<SkillRow> out;
    QDir dir(root());
    if (!dir.exists())
        return out;

    QDirIterator it(root(), QStringList{QStringLiteral("SKILL.md")}, QDir::Files,
                    QDirIterator::Subdirectories);
    while (it.hasNext()) {
        const QString path = it.next();
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
            continue;
        const QString text = QString::fromUtf8(f.readAll());
        f.close();
        SkillFrontmatter fm;
        QString body;
        parse(text, &fm, &body);
        // Default name/group from the directory layout when frontmatter omits.
        const QDir skillDir = QFileInfo(path).absoluteDir();
        if (fm.name.isEmpty())
            fm.name = skillDir.dirName();
        if (fm.group.isEmpty()) {
            const QString parent = QFileInfo(skillDir.absolutePath()).absoluteDir().dirName();
            fm.group = parent;
        }
        SkillRow row;
        row.fm = fm;
        row.path = path;
        out.push_back(row);
    }

    std::sort(out.begin(), out.end(), [](const SkillRow &a, const SkillRow &b) {
        if (a.fm.group != b.fm.group)
            return a.fm.group < b.fm.group;
        return a.fm.name < b.fm.name;
    });
    return out;
}

QVector<SkillRow> SkillStore::listAll()
{
    QVector<SkillRow> out = list();   // the Jarvis library (root())
    // Only fold in the CLI dirs for the PRODUCTION store (default root). A test
    // with an overridden root stays isolated (and deterministic) — it must not
    // read the real ~/.codex / ~/.claude skill dirs.
    if (!m_root.isEmpty())
        return out;
    QSet<QString> seen;
    for (const SkillRow &r : out)
        seen.insert(r.fm.name.toLower());

    // Also scan the CLI brains' skill dirs so a skill the model created there
    // (instead of via create_skill) still appears. Jarvis copies win (dedup).
    const QStringList cliRoots = {codexSkillsRoot(), claudeSkillsRoot()};
    for (const QString &cliRoot : cliRoots) {
        QDir dir(cliRoot);
        if (!dir.exists())
            continue;
        QDirIterator it(cliRoot, QStringList{QStringLiteral("SKILL.md")}, QDir::Files,
                        QDirIterator::Subdirectories);
        while (it.hasNext()) {
            const QString path = it.next();
            // Skip the CLI's INTERNAL skills (a dotted dir component like
            // ".system") — those are the tool's own built-ins (imagegen,
            // skill-creator, …), not the user's Jarvis skills. Check ONLY the path
            // BELOW cliRoot (cliRoot itself is dotted: ~/.codex, ~/.claude).
            const QString rel = path.mid(cliRoot.length());
            if (rel.contains(QStringLiteral("/.")))
                continue;
            QFile f(path);
            if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
                continue;
            const QString text = QString::fromUtf8(f.readAll());
            f.close();
            SkillFrontmatter fm;
            QString body;
            parse(text, &fm, &body);
            const QDir skillDir = QFileInfo(path).absoluteDir();
            if (fm.name.isEmpty())
                fm.name = skillDir.dirName();
            if (seen.contains(fm.name.toLower()))
                continue;   // already in the Jarvis library
            seen.insert(fm.name.toLower());
            if (fm.group.isEmpty()) {
                const QString parent = QFileInfo(skillDir.absolutePath()).absoluteDir().dirName();
                fm.group = parent;
            }
            SkillRow row;
            row.fm = fm;
            row.path = path;
            out.push_back(row);
        }
    }
    std::sort(out.begin(), out.end(), [](const SkillRow &a, const SkillRow &b) {
        if (a.fm.group != b.fm.group)
            return a.fm.group < b.fm.group;
        return a.fm.name < b.fm.name;
    });
    return out;
}

std::optional<SkillRow> SkillStore::get(const QString &name)
{
    const QString want = name.trimmed();
    const QString wantSlug = slug(want);
    // listAll() so a skill that lives ONLY in a CLI dir (model created it there)
    // is still get-able / invokable / removable — not just visible in the list.
    for (const SkillRow &row : listAll()) {
        if (row.fm.name.compare(want, Qt::CaseInsensitive) == 0)
            return row;
        const QString dirName = QFileInfo(row.path).absoluteDir().dirName();
        if (dirName.compare(wantSlug, Qt::CaseInsensitive) == 0 ||
            dirName.compare(want, Qt::CaseInsensitive) == 0)
            return row;
    }
    return std::nullopt;
}

bool SkillStore::read(const QString &name, SkillFrontmatter *fmOut, QString *bodyOut,
                      QString *pathOut)
{
    auto row = get(name);
    if (!row) {
        m_lastError = QStringLiteral("no such skill: ") + name;
        return false;
    }
    QFile f(row->path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        m_lastError = QStringLiteral("cannot read skill: ") + row->path;
        return false;
    }
    const QString text = QString::fromUtf8(f.readAll());
    f.close();
    parse(text, fmOut, bodyOut);
    if (fmOut && fmOut->name.isEmpty())
        fmOut->name = row->fm.name;
    if (fmOut && fmOut->group.isEmpty())
        fmOut->group = row->fm.group;
    if (pathOut)
        *pathOut = row->path;
    return true;
}

QString SkillStore::create(const QString &name, const QString &description,
                           const QString &body, const QString &group,
                           const QStringList &tags, const QVector<SkillScript> &scripts)
{
    if (name.trimmed().isEmpty()) {
        m_lastError = QStringLiteral("skill name is required");
        return QString();
    }
    const QString grp = group.trimmed().isEmpty() ? QStringLiteral("self") : slug(group);
    const QString nm = slug(name);
    const QString skillDirPath =
        root() + QStringLiteral("/") + grp + QStringLiteral("/") + nm;

    QDir().mkpath(skillDirPath);

    SkillFrontmatter fm;
    fm.name = name.trimmed();
    fm.description = description.trimmed();
    fm.group = grp;
    fm.tags = tags;
    fm.selfAuthored = true;

    const QString md = serialize(fm, body);
    const QString mdPath = skillDirPath + QStringLiteral("/SKILL.md");
    {
        QFile f(mdPath);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Text)) {
            m_lastError = QStringLiteral("cannot write skill: ") + mdPath;
            return QString();
        }
        f.write(md.toUtf8());
        f.close();
    }

    // Optional bundled scripts.
    if (!scripts.isEmpty()) {
        const QString scriptsDir = skillDirPath + QStringLiteral("/scripts");
        QDir().mkpath(scriptsDir);
        for (const SkillScript &s : scripts) {
            if (s.name.trimmed().isEmpty())
                continue;
            QFile sf(scriptsDir + QStringLiteral("/") + s.name);
            if (sf.open(QIODevice::WriteOnly)) {
                sf.write(s.content.toUtf8());
                sf.close();
                sf.setPermissions(sf.permissions() | QFileDevice::ExeOwner |
                                  QFileDevice::ExeGroup);
            }
        }
    }

    // Mirror into the active CLI brains' skill dirs so codex/claude pick it up.
    // Production only — a test with an overridden root must not write to the real
    // ~/.codex / ~/.claude dirs (that used to leave stale skills behind).
    if (m_root.isEmpty())
        mirrorToCli(grp, nm, md, scripts);

    return mdPath;
}

int SkillStore::syncMirrorsToCli()
{
    if (!m_root.isEmpty())
        return 0; // tests: never touch the real ~/.codex / ~/.claude
    int n = 0;
    const QVector<SkillRow> rows = list();
    for (const SkillRow &row : rows) {
        QFile f(row.path);
        if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
            continue;
        const QString md = QString::fromUtf8(f.readAll());
        f.close();
        // On-disk layout is <root>/<group>/<name>/SKILL.md — mirror by the SAME
        // directory pair so the copy lands exactly where create() put its own.
        const QDir skillDir = QFileInfo(row.path).absoluteDir();
        const QString name = skillDir.dirName();
        const QString group =
            QFileInfo(skillDir.absolutePath()).absoluteDir().dirName();
        QVector<SkillScript> scripts;
        const QDir sd(skillDir.absoluteFilePath(QStringLiteral("scripts")));
        if (sd.exists()) {
            const QFileInfoList files = sd.entryInfoList(QDir::Files | QDir::NoDotAndDotDot);
            for (const QFileInfo &si : files) {
                QFile sf(si.absoluteFilePath());
                if (!sf.open(QIODevice::ReadOnly))
                    continue;
                scripts.push_back({si.fileName(), QString::fromUtf8(sf.readAll())});
                sf.close();
            }
        }
        mirrorToCli(group, name, md, scripts);
        ++n;
    }
    return n;
}

void SkillStore::mirrorToCli(const QString &group, const QString &name, const QString &md,
                             const QVector<SkillScript> &scripts)
{
    const QStringList roots = {codexSkillsRoot(), claudeSkillsRoot()};
    for (const QString &cliRoot : roots) {
        // Only mirror if the CLI's parent config dir already exists (i.e. the
        // CLI is installed/used) — never create ~/.codex or ~/.claude ourselves.
        const QFileInfo parent(QFileInfo(cliRoot).absolutePath());
        if (!parent.exists())
            continue;
        const QString dest =
            cliRoot + QStringLiteral("/") + group + QStringLiteral("/") + name;
        if (!QDir().mkpath(dest))
            continue;
        QFile f(dest + QStringLiteral("/SKILL.md"));
        if (f.open(QIODevice::WriteOnly | QIODevice::Text)) {
            f.write(md.toUtf8());
            f.close();
        }
        if (!scripts.isEmpty()) {
            const QString sd = dest + QStringLiteral("/scripts");
            QDir().mkpath(sd);
            for (const SkillScript &s : scripts) {
                if (s.name.trimmed().isEmpty())
                    continue;
                QFile sf(sd + QStringLiteral("/") + s.name);
                if (sf.open(QIODevice::WriteOnly)) {
                    sf.write(s.content.toUtf8());
                    sf.close();
                }
            }
        }
    }
}

bool SkillStore::remove(const QString &name)
{
    auto row = get(name);
    if (!row) {
        m_lastError = QStringLiteral("no such skill: ") + name;
        return false;
    }
    QDir skillDir = QFileInfo(row->path).absoluteDir();
    if (!skillDir.removeRecursively()) {
        m_lastError = QStringLiteral("failed to remove skill dir: ") +
                      skillDir.absolutePath();
        return false;
    }
    // Also remove the root + CLI MIRROR copies for this group/name so a deleted
    // skill can't resurface in the list from a leftover ~/.codex / ~/.claude copy
    // (production only — a test with an overridden root doesn't touch real dirs).
    if (m_root.isEmpty()) {
        const QString grp = row->fm.group.isEmpty() ? QStringLiteral("self") : row->fm.group;
        const QString nm = slug(row->fm.name);
        const QStringList roots = {root(), codexSkillsRoot(), claudeSkillsRoot()};
        for (const QString &r : roots) {
            QDir d(r + QStringLiteral("/") + grp + QStringLiteral("/") + nm);
            if (d.exists())
                d.removeRecursively();
        }
    }
    return true;
}

QString SkillStore::invoke(const QString &name, const QString &args,
                           const QJsonObject &vars, QString *err)
{
    SkillFrontmatter fm;
    QString body, path;
    if (!read(name, &fm, &body, &path)) {
        if (err)
            *err = m_lastError;
        return QString();
    }
    const QString skillDir = QFileInfo(path).absoluteDir().absolutePath();

    QJsonObject allVars = vars;
    allVars.insert(QStringLiteral("SKILL_DIR"), skillDir);
    allVars.insert(QStringLiteral("ARGS"), args);
    allVars.insert(QStringLiteral("SKILL_NAME"), fm.name);

    const QString rendered = renderTemplate(body, allVars);

    // Frame the invocation as a DIRECTIVE (like Claude Code): load the WHOLE skill
    // and apply/execute it NOW — not as background FYI. The full rendered body is
    // delimited so the model treats it as its operating instructions for this task.
    QString out = QStringLiteral(
        "[SKILL INVOKED] The user ran the \"%1\" skill. Read it IN FULL below and "
        "FOLLOW / APPLY it now as your instructions for this task — actually do what "
        "it says (don't just acknowledge it)").arg(fm.name);
    if (!args.trimmed().isEmpty())
        out += QStringLiteral(" with args: %1").arg(args.trimmed());
    out += QStringLiteral(".\n");
    if (!fm.description.isEmpty())
        out += QStringLiteral("Purpose: %1\n").arg(fm.description);
    out += QStringLiteral("Skill directory (you may read/run files in it): %1\n\n").arg(skillDir);
    out += QStringLiteral("───── BEGIN SKILL: %1 ─────\n").arg(fm.name);
    out += rendered;
    if (!rendered.endsWith(QLatin1Char('\n')))
        out += QLatin1Char('\n');
    out += QStringLiteral("───── END SKILL ─────");
    return out;
}

} // namespace jarvis
