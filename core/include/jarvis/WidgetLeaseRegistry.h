#pragma once

// WidgetLeaseRegistry — file-backed "who is watching which live widget" registry.
//
// A live widget (computer-use engine) only does work (shell exec + bus append)
// while a fresh VIEWER LEASE covers it; otherwise it idles to save battery on the
// laptop AND the phone. The daemon is the single writer of leases: desktop + phone
// clients send `widget.viewing` / `widget.pin`, and this records each as a small
// JSON file {scope, kind, source, ts} under a directory the engine's live-widget
// supervisor reads (honoring a TTL).
//
//   scope:  "<session_id>" (a chat) | "all" (Canvas tab) | "widget:<id>" (a
//           popped-out window or a phone home-screen pin)
//   kind:   "chat" | "canvas" | "popout" | "pin"   (pin is battery-floored)
//   source: the client that holds the lease ("desktop" or a device id) — so a
//           client's leases can be dropped wholesale when it disconnects.
//
// Leases are EPHEMERAL: wipeAll() is called on daemon startup so a crashed daemon
// can't leave a phantom "all" lease pinning every job on; they are rebuilt from
// live connections + ~15s heartbeats.

#include <QString>
#include <QStringList>

namespace jarvis {

class WidgetLeaseRegistry {
public:
    // dir defaults to $JARVIS_WIDGET_VIEWERS or ~/.local/share/jarvis/widget_viewers
    // (the SAME directory the Python supervisor reads).
    explicit WidgetLeaseRegistry(const QString &dir = QString());

    // Register or refresh a lease. tsMs < 0 means "now". Best-effort (never throws).
    void touch(const QString &scope, const QString &kind, const QString &source,
               qint64 tsMs = -1);
    // Drop one lease (scope held by source).
    void clear(const QString &scope, const QString &source);
    // Drop every lease held by a source (call on that client's disconnect).
    void clearSource(const QString &source);
    // Drop every lease (call once on daemon startup).
    void wipeAll();
    // Remove leases older than ttlMs; returns how many were removed.
    int sweep(qint64 ttlMs = 45000, qint64 nowMs = -1);

    // Scopes with at least one fresh lease (for tests / introspection).
    QStringList activeScopes(qint64 ttlMs = 45000, qint64 nowMs = -1) const;

    QString dir() const { return m_dir; }

    static QString defaultDir();

private:
    QString keyFor(const QString &source, const QString &scope) const;
    QString m_dir;
};

} // namespace jarvis
