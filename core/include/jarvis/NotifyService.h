#pragma once

// NotifyService — desktop notifications on attention events
// (BUILD_SPEC CONTRACT-A additions: "on attention events (approval needed,
// schedule done, task done) call notify-send (desktop)").
//
// A thin, fire-and-forget wrapper over the `notify-send` CLI (libnotify), which
// is part of the verified toolchain (mako is the notification daemon on the
// Sway/KDE session). All calls are non-blocking (QProcess::startDetached) and
// silently no-op if notify-send is unavailable, so the daemon never blocks or
// fails because of notifications.

#include <QString>

namespace jarvis {

class NotifyService {
public:
    enum class Urgency { Low, Normal, Critical };

    NotifyService() = default;

    // Send a desktop notification. Non-blocking; returns false only if the
    // process could not be spawned at all (missing notify-send). `category`
    // groups notifications (e.g. "jarvis.approval"); empty => none.
    bool notify(const QString &title, const QString &body,
                Urgency urgency = Urgency::Normal,
                const QString &category = QString()) const;

    // Convenience helpers for the three spec attention events.
    bool approvalNeeded(const QString &summary, const QString &sessionId = QString()) const;
    bool scheduleDone(const QString &name) const;
    bool taskDone(const QString &summary) const;

    // True if `notify-send` is resolvable on PATH (cached after first call).
    static bool available();

private:
    static QString urgencyString(Urgency u);
};

} // namespace jarvis
