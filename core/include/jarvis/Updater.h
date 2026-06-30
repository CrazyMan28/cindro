#pragma once

// Updater — Jarvis cross-platform self-update (Linux + Windows).
//
// The actual git pull / installer download lives in the platform scripts, which
// already exist and are NOT rewritten here:
//   Linux   -> packaging/update.sh        (check|apply, prints JSON)
//   Windows -> windows/scripts/update.ps1  (-Mode check|apply, prints JSON)
//
// This class only RUNS the right script (QProcess) and PARSES its JSON. `check()`
// reports {current, latest, behind, version}; `apply()` runs apply-mode and
// returns {updated, to, ...}. A QTimer re-checks every auto_update_interval_hours
// when auto_update is on, but NEVER auto-applies — on "behind" it emits
// updateAvailable() so the daemon notifies and the user confirms apply (safer).
//
// The running build identity (JARVIS_VERSION / JARVIS_GIT_SHA) is stamped in at
// configure time by CMake (target_compile_definitions on jarvis-core); the pure
// JSON-parse + behind/up-to-date compare is factored into static functions so it
// is unit-testable with no process or network.

#include <QJsonObject>
#include <QObject>
#include <QString>

class QTimer;

namespace jarvis {

// Parsed result of `<script> check`.
struct UpdateStatus {
    QString current;      // short SHA / version the running build reports
    QString latest;       // latest SHA (Linux) or tag (Windows) on `main`
    bool    behind = false;
    QString version;      // running JARVIS_VERSION (stamped at build)
    QString reason;       // script note (e.g. "not a git checkout"); may be empty
    bool    ok = false;   // the script produced parseable JSON
};

class Updater : public QObject {
    Q_OBJECT
public:
    explicit Updater(QObject *parent = nullptr);
    ~Updater() override;

    // The stamped-in build identity (compile constants; "unknown" if unset).
    static QString runningVersion();
    static QString runningSha();

    // Resolve the platform self-update script relative to the running exe / repo
    // root (honors $JARVIS_REPO_ROOT). Empty string if it can't be located.
    static QString scriptPath();

    // ---- PURE LOGIC (unit-tested; no process / network) -------------------
    // Parse the JSON a `check` run prints and decide behind vs up-to-date. A
    // missing "current" falls back to the stamped runningSha; "behind" honors the
    // script's flag but also derives true from a current!=latest mismatch.
    static UpdateStatus parseCheckResult(const QByteArray &json,
                                         const QString &runningVersion = QString(),
                                         const QString &runningSha = QString());
    // current/latest compare: the script's own behind flag wins; otherwise two
    // non-empty, differing ids count as behind (an empty side => can't tell => up).
    static bool computeBehind(const QString &current, const QString &latest,
                              bool scriptBehind);

    // ---- Process-driven (blocking with a timeout) -------------------------
    // Run `<script> check` and parse it. Blocks up to timeoutMs (a git fetch).
    UpdateStatus checkNow(int timeoutMs = 30000);
    // Run `<script> apply` and return its JSON {updated, to, ...}. Blocks up to
    // timeoutMs (a rebuild / installer can be slow).
    QJsonObject applyNow(int timeoutMs = 600000);

    // Periodic auto-check: when enabled, run checkNow() every intervalHours and
    // emit updateAvailable() on "behind" (NEVER applies). intervalHours<1 -> 6.
    // Re-callable whenever the auto_update / interval settings change.
    void configureAuto(bool enabled, int intervalHours);

signals:
    // A periodic check found the build behind `main` (the daemon notifies).
    void updateAvailable(const jarvis::UpdateStatus &status);
    // A periodic check failed to run/parse (logged; non-fatal).
    void checkFailed(const QString &reason);

private:
    // Build the program + args to run a script in `mode` (check|apply): bash on
    // Linux, powershell -File on Windows.
    static QStringList scriptCommand(const QString &script, const QString &mode);

    QTimer *m_timer = nullptr;
    bool m_autoEnabled = false;
    int m_intervalHours = 6;
};

} // namespace jarvis
