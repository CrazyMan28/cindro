#pragma once

// Shared FTS5 MATCH-query builder for the manual mirror tables (memories_fts,
// events_fts): split arbitrary user text into word tokens (letters/digits, min
// 2 chars), lowercase them, and OR-join as prefix terms. Empty result = the
// caller falls back to its LIKE/recency path. ONE implementation so memory
// search and session search can never diverge on what queries they accept.

#include <QString>
#include <QStringList>

namespace jarvis {

inline QString toFtsQuery(const QString &raw)
{
    QStringList terms;
    QString cur;
    for (const QChar &ch : raw) {
        if (ch.isLetterOrNumber()) {
            cur.append(ch.toLower());
        } else {
            if (cur.size() >= 2)
                terms << cur + QStringLiteral("*");
            cur.clear();
        }
    }
    if (cur.size() >= 2)
        terms << cur + QStringLiteral("*");
    return terms.join(QStringLiteral(" OR "));
}

} // namespace jarvis
