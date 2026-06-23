#pragma once

// AgentDesktop — the nested "agent desktop" manager (Wave 5 target="agent").
//
// For a coworker session whose target is "agent", the BRAIN must drive its OWN
// isolated desktop, never the user's real screen. AgentDesktop owns, per
// session:
//
//   1. a NESTED headless Sway compositor
//        WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c <conf>
//      which creates the output HEADLESS-1 (sized ~1600x1000) and exposes its
//      own wayland-N socket + sway-ipc.<UID>.<PID>.sock. A LOUD cursor theme
//      (XCURSOR_THEME, e.g. a red/neon theme) is set so the agent pointer is
//      visually distinct from the user's. (Proven launch shape — see the repo
//      CLAUDE notes / spikes: a nested headless sway is captured by
//      `WAYLAND_DISPLAY=<sock> grim -o HEADLESS-1 out.png`.)
//
//   2. an instance of the UPGRADED computer-use engine
//      (../computer-use, run via `env -u PYTHONPATH uv run`) bound to that
//      nested compositor through JARVIS_AGENT_WAYLAND_DISPLAY /
//      JARVIS_AGENT_SWAYSOCK, with its OWN config dir + bearer token, on a
//      per-session port (8810+). The daemon injects this engine's MCP url +
//      bearer into the coworker codex spawn so the brain calls the nested
//      desktop's tools instead of the global :8794 engine.
//
// The class is pure C++/Qt (lives in jarvis-core) and is reused by the daemon's
// ControlServer. It does NOT depend on the daemon. Teardown kills the engine
// then the nested sway, removes the per-session config dir, and is idempotent.

#include <QObject>
#include <QProcess>
#include <QString>
#include <QStringList>
#include <map>
#include <memory>

QT_BEGIN_NAMESPACE
class QJsonObject;
QT_END_NAMESPACE

namespace jarvis {

// One running agent desktop (nested sway + a bound computer-use engine).
struct AgentDesktopInfo {
    QString sessionId;          // owning coworker session id
    int port = 0;               // engine MCP port (8810+)
    QString mcpUrl;             // http://127.0.0.1:<port>/mcp
    QString bearer;             // engine bearer token (per-session)
    QString waylandDisplay;     // nested compositor wayland-N socket name
    QString swaysock;           // nested sway-ipc.<uid>.<pid>.sock path
    qint64 swayPid = 0;         // nested sway pid
    qint64 enginePid = 0;       // engine (uv) pid
    int width = 1600;
    int height = 1000;
    bool up = false;            // nested sway + engine both health-checked up

    QJsonObject toJson() const; // omits bearer
};

class AgentDesktop : public QObject {
    Q_OBJECT
public:
    struct Options {
        // Repo root of the upgraded engine (…/computer-use). Defaults to the
        // sibling of the running daemon's source tree.
        QString engineDir;
        int basePort = 8810;        // first per-session engine port
        int width = 1600;
        int height = 1000;
        // Loud cursor theme for the agent pointer (visually distinct).
        QString cursorTheme = QStringLiteral("Bibata-Modern-Ice");
        QString cursorThemeFallback = QStringLiteral("Adwaita");
        int cursorSize = 48;
        QString swayProgram = QStringLiteral("sway");
        QString uvProgram = QStringLiteral("uv");
        // Health-check budget for "nested sway HEADLESS-1 up" + "engine /health".
        // Generous because `uv run` may sync the venv on the very first launch.
        int startupTimeoutMs = 45000;
    };

    explicit AgentDesktop(Options opts, QObject *parent = nullptr);
    ~AgentDesktop() override;

    // Bring up a nested desktop + engine for `sessionId`. Idempotent: if one is
    // already up for the session it is returned as-is. On failure returns a
    // default-constructed (up=false) info and sets *err.
    AgentDesktopInfo ensure(const QString &sessionId, QString *err = nullptr);

    // The live info for a session (up=false default if none).
    AgentDesktopInfo info(const QString &sessionId) const;
    bool has(const QString &sessionId) const
    {
        return m_desks.find(sessionId) != m_desks.end();
    }

    // Kill the engine + nested sway and forget the session. Idempotent.
    void teardown(const QString &sessionId);
    void teardownAll();

    // ORPHAN SWEEP (teardown-leak guard). Reap nested agent compositors (+ their
    // swaybg + per-session engines) that survived a previous daemon (crash,
    // SIGKILL, abrupt restart) and are NOT currently tracked in m_desks. Matches
    // ONLY our own marker — a nested `sway -c <…>/jarvis/agent/sway-*.conf` — so
    // it can never touch the user's real sway/KDE. Called at daemon start and is
    // safe to call repeatedly. Returns the number of orphan compositors reaped.
    int sweepOrphans();

    // Engine endpoints for the daemon's video pump.
    //   <base>/video/frame  (single JPEG)   |  <base>/video/mjpeg (stream)
    QString engineBase(const QString &sessionId) const; // http://127.0.0.1:<port>
    QString bearer(const QString &sessionId) const;

    QString lastError() const { return m_lastError; }

    // Resolve the default engine dir (…/computer-use) relative to this build.
    static QString defaultEngineDir();

private:
    struct Desk {
        AgentDesktopInfo info;
        QProcess *sway = nullptr;
        QProcess *engine = nullptr;
        QString confPath;       // generated nested-sway config
        QString runtimeDir;     // per-session XDG_RUNTIME_DIR for the nested stack
        QString configDir;      // per-session ~/.computer-use clone
    };

    // Pick the next free port at/after basePort not already used by a desk.
    int nextPort() const;
    // Write the nested-sway config (HEADLESS-1 output sized, no bars/idle).
    QString writeSwayConf(const QString &sessionId, int width, int height) const;
    // Discover the nested compositor's wayland-N + sway-ipc socket created under
    // `runtimeDir` after the sway process starts. Returns false on timeout.
    bool discoverSockets(Desk &d, int timeoutMs);
    // Poll the nested sway IPC for HEADLESS-1 being present.
    bool waitForHeadlessOutput(const Desk &d, int timeoutMs);
    // Poll GET <base>/health (bearer) until 200 or timeout.
    bool waitForEngineHealth(const Desk &d, int timeoutMs);
    // DEEP readiness: poll GET <base>/ready until 200 {ready:true} or timeout.
    // /ready does a real grim grab of the nested compositor, so a 200 proves the
    // engine can actually serve a tool call (closes the first-tool-call race).
    bool waitForEngineReady(const Desk &d, int timeoutMs);
    // Generate a per-session bearer token (hex).
    static QString genBearer();
    static void killProc(QProcess *p, int graceMs = 1500);

    Options m_opts;
    QString m_lastError;
    // sessionId -> running desk. std::map (not QHash) because Desk is held by
    // unique_ptr (non-copyable) and QHash is copy-on-write.
    std::map<QString, std::unique_ptr<Desk>> m_desks;
};

} // namespace jarvis
