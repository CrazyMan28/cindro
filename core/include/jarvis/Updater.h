#pragma once

// Updater — Jarvis cross-platform self-update (Linux + Windows).
//
// THREE update strategies, auto-detected at runtime (jarvis#76 follow-up:
// "true self-update" for the packaged apps):
//
//   1. AppImage (Linux, $APPIMAGE env set): NATIVE release flow — query the
//      latest GitHub Release, download the new *.AppImage next to the running
//      one, verify the ELF magic, chmod +x, ATOMICALLY std::rename() it over
//      $APPIMAGE (POSIX rename replaces in place; the running mmap keeps the
//      old inode), and report restart_required. The read-only squashfs mount
//      has no scripts, so this path never shells out.
//   2. Windows packaged install (no repo scripts on disk): NATIVE release
//      flow — download Jarvis-Setup-<ver>.exe to %TEMP%, verify the MZ magic,
//      and launch it detached with /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
//      /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS (Inno closes the running apps,
//      installs, and relaunches them).
//   3. Git checkout (the repo scripts ARE on disk): the pre-existing script
//      flow — packaging/update.sh (pull + rebuild + restart) on Linux,
//      windows/scripts/update.ps1 on Windows. The running version is now
//      passed to the .ps1 explicitly (it used to read an env var nobody set,
//      so Windows checks NEVER reported behind).
//
// `check()` reports {current, latest, behind, version}; `apply()` returns
// {updated, to, ...}. A QTimer re-checks every auto_update_interval_hours when
// auto_update is on; on "behind" it emits updateAvailable() and — ONLY when
// the new auto_update_apply setting is on — applies in place automatically.
//
// The running build identity (JARVIS_VERSION / JARVIS_GIT_SHA) is stamped in at
// configure time by CMake; the pure JSON/semver/asset-pick logic is factored
// into static functions so it is unit-testable with no process or network.

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

    // ---- native GitHub-release flow (pure parts unit-tested) ----------------
    // True when running from an AppImage ($APPIMAGE env, set by the runtime).
    static bool isAppImage();
    // "1.2.10" vs "1.2.9" -> true; tolerant of a leading 'v'; non-numeric
    // segments compare as 0. Empty/unknown never counts as newer.
    static bool versionGreater(const QString &latest, const QString &current);
    // Parse a GitHub /releases/latest JSON body: returns {tag, url, name} for
    // the FIRST asset whose name matches assetGlob (e.g. "Jarvis-Setup-*.exe",
    // "*.AppImage"). Empty tag on parse failure / no matching asset.
    struct ReleaseAsset {
        QString tag;   // "0.13.2" (leading v stripped)
        QString url;   // browser_download_url
        QString name;  // asset file name
    };
    static ReleaseAsset parseLatestRelease(const QByteArray &json,
                                           const QString &assetGlob);

    // ---- Process-driven (blocking with a timeout) -------------------------
    // Run `<script> check` and parse it. Blocks up to timeoutMs (a git fetch).
    UpdateStatus checkNow(int timeoutMs = 30000);
    // Run `<script> apply` and return its JSON {updated, to, ...}. Blocks up to
    // timeoutMs (a rebuild / installer can be slow).
    QJsonObject applyNow(int timeoutMs = 600000);

    // Periodic auto-check: when enabled, run checkNow() every intervalHours and
    // emit updateAvailable() on "behind". When autoApply is ALSO on, applyNow()
    // runs right after (the "install updates automatically" toggle) and
    // autoApplied() reports the outcome. intervalHours<1 -> 6.
    // Re-callable whenever the auto_update / interval / apply settings change.
    void configureAuto(bool enabled, int intervalHours, bool autoApply = false);

signals:
    // A periodic check found the build behind `main` (the daemon notifies).
    void updateAvailable(const jarvis::UpdateStatus &status);
    // Auto-apply (auto_update_apply=on) finished: result = applyNow()'s JSON.
    void autoApplied(const QJsonObject &result);
    // A periodic check failed to run/parse (logged; non-fatal).
    void checkFailed(const QString &reason);

private:
    // Build the program + args to run a script in `mode` (check|apply): bash on
    // Linux, powershell -File on Windows (running version passed along).
    static QStringList scriptCommand(const QString &script, const QString &mode);
    // Bounded-blocking HTTP GET (local NAM + nested loop, FcmSender pattern).
    // Returns the body; empty on error/timeout. Follows redirects.
    static QByteArray httpGet(const QString &url, int timeoutMs);
    // Fetch + parse the latest release for this platform's asset glob.
    static ReleaseAsset latestRelease(int timeoutMs);
    // Which asset the running platform updates from.
    static QString assetGlob();
    // Native release check/apply (AppImage + Windows packaged).
    UpdateStatus releaseCheck(int timeoutMs);
    QJsonObject releaseApply(int timeoutMs);

    QTimer *m_timer = nullptr;
    bool m_autoEnabled = false;
    bool m_autoApply = false;
    bool m_applyInFlight = false; // one auto-apply at a time (worker thread)
    int m_intervalHours = 6;
};

} // namespace jarvis
