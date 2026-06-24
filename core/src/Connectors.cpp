#include "jarvis/Connectors.h"

namespace jarvis {

const QVector<ConnectorService> &Connectors::catalog()
{
    // The known Google connector services. Each is a stdio MCP server launched
    // via npx; OAuth creds are injected via env (GOOGLE_OAUTH_*). Risk tiers
    // reflect the blast radius of the granted scope (Gmail/Drive highest).
    static const QVector<ConnectorService> kCatalog = {
        {QStringLiteral("calendar"), QStringLiteral("Google Calendar"),
         QStringLiteral("npx -y @cocal/google-calendar-mcp"), QStringLiteral("medium")},
        {QStringLiteral("docs"), QStringLiteral("Google Docs"),
         // Google Docs are Drive files; the official Drive MCP reads/exports them.
         QStringLiteral("npx -y @modelcontextprotocol/server-gdrive"), QStringLiteral("medium")},
        {QStringLiteral("drive"), QStringLiteral("Google Drive"),
         QStringLiteral("npx -y @modelcontextprotocol/server-gdrive"), QStringLiteral("high")},
        {QStringLiteral("gmail"), QStringLiteral("Gmail"),
         QStringLiteral("npx -y @gongrzhe/server-gmail-autoauth-mcp"), QStringLiteral("high")},
    };
    return kCatalog;
}

bool Connectors::isKnownService(const QString &service)
{
    for (const ConnectorService &c : catalog())
        if (c.service == service)
            return true;
    return false;
}

QString Connectors::defaultCommandFor(const QString &service)
{
    for (const ConnectorService &c : catalog())
        if (c.service == service)
            return c.defaultCommand;
    return QString();
}

QString Connectors::displayNameFor(const QString &service)
{
    for (const ConnectorService &c : catalog())
        if (c.service == service)
            return c.displayName;
    return QString();
}

QString Connectors::riskFor(const QString &service)
{
    for (const ConnectorService &c : catalog())
        if (c.service == service)
            return c.risk;
    return QStringLiteral("medium");
}

QString Connectors::serverName(const QString &service)
{
    return QStringLiteral("google-") + service;
}

QString Connectors::serviceFromServerName(const QString &name)
{
    const QString prefix = QStringLiteral("google-");
    if (!name.startsWith(prefix))
        return QString();
    return name.mid(prefix.size());
}

QString Connectors::secretKey(const QString &connectorId, const QString &field)
{
    return QStringLiteral("connector:") + connectorId + QLatin1Char(':') + field;
}

QString Connectors::secretRef(const QString &connectorId, const QString &field)
{
    return QStringLiteral("secret:") + secretKey(connectorId, field);
}

} // namespace jarvis
