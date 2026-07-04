#include "jarvis/TuiLayoutStore.h"
#include "jarvis/DataPaths.h"   // jarvis::dataDir() — same header WidgetLeaseRegistry.cpp uses

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>

namespace jarvis {

namespace {
const QStringList kReserved = {
    QStringLiteral("chat"), QStringLiteral("sessions"), QStringLiteral("memory"),
    QStringLiteral("skills"), QStringLiteral("agents"), QStringLiteral("queue"),
    QStringLiteral("settings"), QStringLiteral("canvas"), QStringLiteral("widgets"),
    QStringLiteral("phone"), QStringLiteral("computer"), QStringLiteral("browser"),
    QStringLiteral("activity"), QStringLiteral("replay"), QStringLiteral("mcp"),
    QStringLiteral("plugins"), QStringLiteral("ssh"), QStringLiteral("memorygraph"),
    QStringLiteral("home"), QStringLiteral("schedules"),
};
const QStringList kKinds = {
    QStringLiteral("log"), QStringLiteral("table"), QStringLiteral("markdown"),
    QStringLiteral("widget"), QStringLiteral("list"),
};
}

TuiLayoutStore::TuiLayoutStore(const QString &dir)
    : m_dir(dir.isEmpty() ? defaultDir() : dir)
{
    QDir().mkpath(m_dir);
}

QString TuiLayoutStore::defaultDir() { return jarvis::dataDir(); }

bool TuiLayoutStore::isReservedId(const QString &id) { return kReserved.contains(id); }
QStringList TuiLayoutStore::reservedIds() { return kReserved; }
bool TuiLayoutStore::isValidKind(const QString &kind) { return kKinds.contains(kind); }

QString TuiLayoutStore::filePath() const { return m_dir + QStringLiteral("/tui_layout.json"); }

QVector<TuiPageSpec> TuiLayoutStore::load() const
{
    QVector<TuiPageSpec> out;
    QFile f(filePath());
    if (!f.open(QIODevice::ReadOnly))
        return out;
    const auto doc = QJsonDocument::fromJson(f.readAll());
    if (!doc.isArray())
        return out;
    for (const auto &v : doc.array()) {
        const auto o = v.toObject();
        TuiPageSpec p;
        p.id = o.value(QStringLiteral("id")).toString();
        p.title = o.value(QStringLiteral("title")).toString();
        p.kind = o.value(QStringLiteral("kind")).toString();
        p.config = o.value(QStringLiteral("config")).toObject();
        p.order = o.value(QStringLiteral("order")).toInt();
        if (!p.id.isEmpty())
            out.push_back(p);
    }
    return out;
}

bool TuiLayoutStore::save(const QVector<TuiPageSpec> &pages) const
{
    QJsonArray arr;
    for (const auto &p : pages) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), p.id);
        o.insert(QStringLiteral("title"), p.title);
        o.insert(QStringLiteral("kind"), p.kind);
        o.insert(QStringLiteral("config"), p.config);
        o.insert(QStringLiteral("order"), p.order);
        arr.append(o);
    }
    QFile f(filePath());
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    f.write(QJsonDocument(arr).toJson(QJsonDocument::Compact));
    return true;
}

QVector<TuiPageSpec> TuiLayoutStore::list() const
{
    auto pages = load();
    std::sort(pages.begin(), pages.end(),
              [](const TuiPageSpec &a, const TuiPageSpec &b) { return a.order < b.order; });
    return pages;
}

bool TuiLayoutStore::addPage(const TuiPageSpec &page, QString *error)
{
    if (isReservedId(page.id)) {
        if (error) *error = QStringLiteral("reserved page id");
        return false;
    }
    if (!isValidKind(page.kind)) {
        if (error) *error = QStringLiteral("invalid kind");
        return false;
    }
    auto pages = load();
    for (const auto &p : pages) {
        if (p.id == page.id) {
            if (error) *error = QStringLiteral("id already exists");
            return false;
        }
    }
    TuiPageSpec toAdd = page;
    toAdd.order = static_cast<int>(pages.size());
    pages.push_back(toAdd);
    return save(pages);
}

bool TuiLayoutStore::editPage(const QString &id, const QJsonObject &config, QString *error)
{
    auto pages = load();
    for (auto &p : pages) {
        if (p.id == id) {
            p.config = config;
            return save(pages);
        }
    }
    if (error) *error = QStringLiteral("no such page");
    return false;
}

bool TuiLayoutStore::removePage(const QString &id, QString *error)
{
    auto pages = load();
    const auto before = pages.size();
    pages.erase(std::remove_if(pages.begin(), pages.end(),
                                [&](const TuiPageSpec &p) { return p.id == id; }),
                pages.end());
    if (pages.size() == before) {
        if (error) *error = QStringLiteral("no such page");
        return false;
    }
    return save(pages);
}

bool TuiLayoutStore::reorder(const QStringList &orderedIds, QString *error)
{
    auto pages = load();
    if (orderedIds.size() != pages.size()) {
        if (error) *error = QStringLiteral("order list must include every custom page id");
        return false;
    }
    QVector<TuiPageSpec> reordered;
    for (const auto &id : orderedIds) {
        bool found = false;
        for (const auto &p : pages) {
            if (p.id == id) {
                reordered.push_back(p);
                found = true;
                break;
            }
        }
        if (!found) {
            if (error) *error = QStringLiteral("unknown id in order list: ") + id;
            return false;
        }
    }
    for (int i = 0; i < reordered.size(); ++i)
        reordered[i].order = i;
    return save(reordered);
}

} // namespace jarvis
