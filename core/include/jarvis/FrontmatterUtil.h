#pragma once

// FrontmatterUtil — the flat-key "YAML" frontmatter parse/write helpers
// factored out of SkillStore so CommandStore reuses the SAME hand-rolled
// parser rather than duplicating it. Both stores persist a Markdown file
// with a leading "---"-fenced block of flat `key: value` lines followed by a
// document body. "Flat" means scalar string values only — typed
// interpretation (inline lists, booleans) is the caller's job.

#include <QMap>
#include <QString>
#include <QStringList>

#include <utility>

namespace jarvis {

// Strip a matching pair of surrounding single/double quotes from a scalar.
inline QString fmUnquote(const QString &raw)
{
    QString t = raw.trimmed();
    if ((t.startsWith(QLatin1Char('"')) && t.endsWith(QLatin1Char('"'))) ||
        (t.startsWith(QLatin1Char('\'')) && t.endsWith(QLatin1Char('\''))))
        return t.mid(1, t.size() - 2);
    return t;
}

// Split raw file text into {frontmatter-block, document-body}. The
// frontmatter is the text BETWEEN a leading "---" line and the next "---"
// line; with no well-formed fence the whole text is the body and the
// frontmatter is empty.
inline std::pair<QString, QString> splitFrontmatter(const QString &text)
{
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
            QStringList frontLines;
            for (int i = 1; i < close; ++i)
                frontLines << lines[i];
            QStringList bodyLines;
            for (int i = close + 1; i < lines.size(); ++i)
                bodyLines << lines[i];
            QString body = bodyLines.join(QLatin1Char('\n'));
            // Trim a single leading blank line after the closing delimiter.
            if (body.startsWith(QLatin1Char('\n')))
                body.remove(0, 1);
            return {frontLines.join(QLatin1Char('\n')), body};
        }
    }
    return {QString(), text};
}

// Parse a frontmatter block into flat key -> value pairs, splitting each
// line on its first ':'. Values are unquoted; a later duplicate key wins.
inline QMap<QString, QString> parseFlatFrontmatter(const QString &front)
{
    QMap<QString, QString> out;
    const QStringList lines = front.split(QLatin1Char('\n'));
    for (const QString &line : lines) {
        const int colon = line.indexOf(QLatin1Char(':'));
        if (colon < 0)
            continue;
        const QString key = line.left(colon).trimmed();
        if (key.isEmpty())
            continue;
        out.insert(key, fmUnquote(line.mid(colon + 1).trimmed()));
    }
    return out;
}

// Serialize flat key -> value pairs into a "---"-fenced frontmatter block
// (with a trailing newline after the closing "---"). The caller appends its
// own body.
inline QString writeFlatFrontmatter(const QMap<QString, QString> &fm)
{
    QString out = QStringLiteral("---\n");
    for (auto it = fm.begin(); it != fm.end(); ++it)
        out += it.key() + QStringLiteral(": ") + it.value() + QStringLiteral("\n");
    out += QStringLiteral("---\n");
    return out;
}

} // namespace jarvis
