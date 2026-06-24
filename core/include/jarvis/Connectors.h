#pragma once

// Connectors — the catalog of known Google connector services (Calendar, Docs,
// Drive, Gmail) plus pure helpers. A connector is a stdio MCP server row named
// "google-<service>" whose OAuth creds ride in its env map (resolved from the
// SettingsStore at injection time). This header is pure data + helpers; no I/O.

#include <QString>
#include <QVector>

namespace jarvis {

struct ConnectorService {
    QString service;        // catalog id, e.g. "calendar"
    QString displayName;    // e.g. "Google Calendar"
    QString defaultCommand; // default stdio command line (npx -y <pkg>)
    QString risk;           // suggested risk tier ("low"|"medium"|"high")
};

namespace Connectors {

// The known Google services (Calendar/Docs/Drive/Gmail).
const QVector<ConnectorService> &catalog();

// True if `service` is one of the known catalog ids.
bool isKnownService(const QString &service);

// The default stdio command line for `service` (empty if unknown).
QString defaultCommandFor(const QString &service);

// The human display name for `service` (empty if unknown).
QString displayNameFor(const QString &service);

// The suggested risk tier for `service` ("medium" fallback if unknown).
QString riskFor(const QString &service);

// The MCP server name for a connector service ("google-<service>").
QString serverName(const QString &service);

// The "<service>" extracted from a "google-<service>" server name (empty if the
// name is not a google connector).
QString serviceFromServerName(const QString &name);

// The SettingsStore secret key for a connector's OAuth field, e.g.
// "connector:<connectorId>:client_secret".
QString secretKey(const QString &connectorId, const QString &field);

// The "secret:<key>" reference token stored in a row's env map (resolved by the
// daemon through SettingsStore at injection time).
QString secretRef(const QString &connectorId, const QString &field);

} // namespace Connectors

} // namespace jarvis
