#pragma once

// TuiLayoutStore — file-backed CRUD for the terminal client's CUSTOM (non-
// builtin) page layout. Lets Jarvis add/edit/remove/reorder TUI pages via
// an MCP tool WITHOUT touching source code: each custom page is a small
// declarative spec {id, title, kind, config}, kind in
// {log, table, markdown, widget, list}. The 20 builtin pages are reserved
// ids and never stored here.

#include <QJsonObject>
#include <QString>
#include <QVector>

namespace jarvis {

struct TuiPageSpec {
    QString id;
    QString title;
    QString kind;       // log | table | markdown | widget | list
    QJsonObject config;
    int order = 0;
};

class TuiLayoutStore {
public:
    // dir defaults to jarvis::dataDir() (the same root as widget_viewers/,
    // agent/, etc.) — file is "<dir>/tui_layout.json".
    explicit TuiLayoutStore(const QString &dir = QString());

    QVector<TuiPageSpec> list() const;
    bool addPage(const TuiPageSpec &page, QString *error);
    bool editPage(const QString &id, const QJsonObject &config, QString *error);
    bool removePage(const QString &id, QString *error);
    bool reorder(const QStringList &orderedIds, QString *error);

    static bool isReservedId(const QString &id);
    static QStringList reservedIds();
    static bool isValidKind(const QString &kind);
    static QString defaultDir();

private:
    QString filePath() const;
    QVector<TuiPageSpec> load() const;
    bool save(const QVector<TuiPageSpec> &pages) const;

    QString m_dir;
};

} // namespace jarvis
