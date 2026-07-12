#include "jarvis/NotifyService.h"

#include <QStandardPaths>
#include <QProcess>

namespace jarvis {

QString NotifyService::urgencyString(Urgency u)
{
    switch (u) {
    case Urgency::Low:
        return QStringLiteral("low");
    case Urgency::Critical:
        return QStringLiteral("critical");
    case Urgency::Normal:
    default:
        return QStringLiteral("normal");
    }
}

bool NotifyService::available()
{
    static const bool ok =
        !QStandardPaths::findExecutable(QStringLiteral("notify-send")).isEmpty();
    return ok;
}

bool NotifyService::notify(const QString &title, const QString &body, Urgency urgency,
                           const QString &category) const
{
    if (!available())
        return false;

    QStringList args;
    args << QStringLiteral("--app-name=Cindro")
         << QStringLiteral("--urgency=") + urgencyString(urgency);
    if (!category.isEmpty())
        args << QStringLiteral("--category=") + category;
    // Title then body as the two trailing positionals (notify-send convention).
    args << title;
    if (!body.isEmpty())
        args << body;

    // Detached + non-blocking: never stall the daemon's event loop on a notif.
    return QProcess::startDetached(QStringLiteral("notify-send"), args);
}

bool NotifyService::approvalNeeded(const QString &summary, const QString &sessionId) const
{
    QString body = summary.isEmpty()
                       ? QStringLiteral("Cindro needs your approval")
                       : summary;
    if (!sessionId.isEmpty())
        body += QStringLiteral("\nSession: ") + sessionId;
    return notify(QStringLiteral("Cindro: approval needed"), body, Urgency::Critical,
                  QStringLiteral("jarvis.approval"));
}

bool NotifyService::scheduleDone(const QString &name) const
{
    return notify(QStringLiteral("Cindro: scheduled task ran"),
                  name.isEmpty() ? QStringLiteral("A scheduled job fired.")
                                 : name,
                  Urgency::Normal, QStringLiteral("jarvis.schedule"));
}

bool NotifyService::taskDone(const QString &summary) const
{
    return notify(QStringLiteral("Cindro: task done"),
                  summary.isEmpty() ? QStringLiteral("A session finished its turn.")
                                    : summary,
                  Urgency::Normal, QStringLiteral("jarvis.done"));
}

} // namespace jarvis
