#pragma once

// Contract A control server: a loopback-only WebSocket endpoint that the
// desktop sidebar (and later other same-user clients) use to drive sessions.
//
//   ws://127.0.0.1:<port>/control/ws?token=<control_token>
//
// The server owns the SessionStore and the live Brain instances, dispatches
// the v1 request methods, and fans NormalizedBrainEvents out to subscribed
// sockets as session.event frames.

#include "jarvis/AgentDesktop.h"
#include "jarvis/AuditLog.h"
#include "jarvis/AuthChallengeStore.h"
#include "jarvis/Config.h"
#include "jarvis/DeviceRegistry.h"
#include "jarvis/FcmSender.h"
#include "jarvis/McpRegistry.h"
#include "jarvis/MemoryStore.h"
#include "jarvis/NotifyService.h"
#include "jarvis/PairingManager.h"
#include "jarvis/PluginRegistry.h"
#include "jarvis/PluginSandbox.h"
#include "jarvis/Protocol.h"
#include "jarvis/Scheduler.h"
#include "jarvis/SessionStore.h"
#include "jarvis/SettingsStore.h"
#include "jarvis/SkillStore.h"
#include "jarvis/SshAllowList.h"
#include "jarvis/VoiceProvider.h"
#include "jarvis/VoiceService.h"
#include "jarvis/WidgetLeaseRegistry.h"

#include <QHash>
#include <QObject>
#include <QSet>
#include <QString>
#include <functional>
#include <memory>

QT_BEGIN_NAMESPACE
class QWebSocketServer;
class QWebSocket;
class QNetworkAccessManager;
QT_END_NAMESPACE

namespace jarvis {

class Brain;

class ControlServer : public QObject {
    Q_OBJECT
public:
    ControlServer(Config config, QString controlToken, QObject *parent = nullptr);
    ~ControlServer() override;

    // Open the SQLite store and start listening on 127.0.0.1:<control_port>.
    // Returns false on failure (see lastError()).
    bool start();
    QString lastError() const { return m_lastError; }

    // --- shared machinery exposed to the device channel (Contract C) -------
    // The DeviceServer reuses the SAME store/brains/registries so a phone and
    // the desktop drive one coherent session world.
    SessionStore &store() { return m_store; }
    DeviceRegistry &devices() { return m_deviceReg; }
    PairingManager &pairing() { return m_pairing; }
    FcmSender *fcm() { return m_fcm.get(); }
    // DeviceServer registers a probe so the unlock flow knows whether a phone is
    // actually CONNECTED + authed over the device WS (a reachable approver even
    // when Firebase/FCM is unavailable).
    void setAuthedDeviceProbe(std::function<bool()> probe) { m_authedDeviceProbe = std::move(probe); }
    // A deliberate phone action (the user started a chat from the authed phone app)
    // grants a short grace where opening/unlocking the desktop is auto-approved —
    // the user is demonstrably present at an unlocked phone. Mere connection does
    // NOT grant this; only an explicit device-initiated action does.
    void grantDeviceAuthGrace(int ms = 60000);
    AgentDesktop &agentDesktops() { return m_agentDesktops; }
    MemoryStore &memory() { return m_memory; }
    SkillStore &skills() { return m_skills; }
    Scheduler &scheduler() { return m_scheduler; }
    SshAllowList &sshAllow() { return m_sshAllow; }
    AuditLog &audit() { return m_audit; }
    // Live-widget viewer leases (battery gating). The DeviceServer writes phone
    // leases here too, so a live widget runs only while a desktop/phone viewer or
    // a home-screen pin is watching it.
    WidgetLeaseRegistry &widgetLeases() { return m_widgetLeases; }

    // Contract A v3 method dispatch shared with the device channel mirror. Each
    // returns the Response for the request; the device server forwards these so
    // the phone can use memory + skills too. (handleRequest also routes here.)
    Response dispatchMemoryOrSkill(const Request &req); // memory.*/skills.* or {} ok=false
    static bool isMemoryOrSkillMethod(const QString &method);

    // FULL Contract-C exposure: the daemon mirrors its whole config surface over
    // the device channel so the phone can configure everything. The DeviceServer
    // forwards reads/actions here; biometric-tier methods (settings.set, mcp.add,
    // take_over.request, plugins install/remove) are gated by the phone before
    // they reach this dispatcher. Returns ok=false unknown_method if `method` is
    // not part of the shared config surface.
    Response dispatchConfigMethod(const Request &req);
    static bool isConfigMethod(const QString &method);

    // Voice (Mistral Voxtral, laptop-proxied). Shared by Contract A + Contract C.
    Response handleVoiceStt(const Request &req);
    Response handleVoiceTts(const Request &req);
    // Curated list of Mistral Voxtral voice slugs for the TTS picker, plus the
    // current default (tts_voice setting / en_paul_neutral fallback).
    Response handleVoiceListVoices(const Request &req);

    // Wave 8 co-worker ops, mirrored over the device channel (schedule.* +
    // ssh.allow_list/add/remove + ssh.exec + audit.list). ssh.exec and
    // schedule.create are biometric-tier on the device side.
    Response dispatchOpsMethod(const Request &req, bool remote = false);
    static bool isOpsMethod(const QString &method);

    // device->phone FILE PUSH (Contract C). Stores the bytes under the jarvis
    // inbox and returns a {file_id,name,size,mime,session_id} descriptor the
    // DeviceServer emits to phones as a 'file.offer' event. b64 OR an on-disk
    // path is accepted. Returns ok=false on bad input / write failure.
    Response handleFilePush(const Request &req);
    // Read a previously pushed file back (for the phone's download). Returns
    // {name,mime,b64} or ok=false.
    Response handleFileGet(const Request &req);

    // Build a "what I'm working on today" digest from project-tracker MCP
    // (project_list / agent_checkin), recent sessions, and recent memories.
    QString buildTodayDigest();

    // The per-session nested-agent-desktop info (up=false default if the session
    // is not a coworker+agent session). Used by the device channel's video pump
    // (mirror.start) to find the engine's /video/mjpeg endpoint + bearer.
    AgentDesktopInfo agentDesktopFor(const QString &sessionId) const;

    // Create a session row + live brain (shared with handleSessionCreate). On
    // success returns the new session id; on failure returns empty and sets
    // *err. `cwd` empty => default. `target` ∈ ""(=real for coder) | "agent" |
    // "real"; coworker+agent spins up an isolated nested desktop + per-session
    // engine and points the brain's computer-use MCP at it.
    QString createSession(const QString &profile, const QString &brain,
                          const QString &model, const QString &cwd,
                          const QString &title, QString *err,
                          const QString &target = QString());

    // target="real" take-over: after a biometric approval the agent drives the
    // user's ACTIVE real session via the global :8794 engine. requestTakeOver
    // records intent + emits the agent-driving overlay state; the actual
    // approval flow rides Contract A approval.respond / Contract C biometric.
    bool requestTakeOver(const QString &sessionId, QString *err);
    bool setTakeOverActive(const QString &sessionId, bool active);
    bool takeOverActive(const QString &sessionId) const
    {
        return m_takeOverActive.contains(sessionId);
    }
    // Send a user turn into an existing live session. False if unknown/inactive.
    bool sendToSession(const QString &sessionId, const QString &text,
                       const QStringList &images, QString *err);
    bool cancelSession(const QString &sessionId, QString *err);
    // Permanently delete a session: cancel/tear down its live brain + nested
    // desktop first, then drop the row + its event stream from the store.
    // Idempotent w.r.t. a missing row; false only on a store error.
    bool deleteSession(const QString &sessionId, QString *err);
    bool respondApprovalFor(const QString &sessionId, const QString &approvalId,
                            const QString &decision, QString *err);

    // 2FA + fingerprint cross-device unlock (FEATURE). Called by the DeviceServer
    // when a paired phone (already passed BiometricPrompt) sends auth.approve over
    // its authed device WS. Flips the in-memory challenge to "approved" and fans an
    // auth.event out to the desktop control clients (instant unlock; poll is the
    // fallback). Returns false (challenge_not_found / expired) when the challenge
    // can't be approved; sets *err.
    bool approveAuthChallenge(const QString &challengeId, const QString &deviceId,
                              QString *err);
    // The phone may also deny (biometric failure). Flips pending->denied + fans out.
    bool denyAuthChallenge(const QString &challengeId, QString *err);

    // The tailnet (tailscale0) IPv4 address, or 127.0.0.1 if none — the host the
    // phone dials in the pairing payload and the device WS binds.
    static QString tailnetHost();

signals:
    // Fired after every brain event is persisted (Contract C device fan-out).
    void sessionEvent(const QString &sessionId, const jarvis::NormalizedBrainEvent &ev);

    // target="real" take-over state changed: the desktop overlay subscribes to
    // this to show / hide the "JARVIS IS DRIVING" layer-shell banner + cursor.
    void agentDrivingChanged(const QString &sessionId, bool driving);

    // A pushed file is available for the phone(s) to download (Contract C
    // 'file.offer' event). `descriptor` = {file_id,name,size,mime,session_id?}.
    void filePushed(const QJsonObject &descriptor);

    // A brand-new session was created (from ANY surface) — signals the apps to
    // OPEN/FOCUS that session's chat. DeviceServer fans this out to authed phones
    // as a 'session.opened' event (+ FCM); the control-WS leg is broadcastSessionOpened.
    void sessionOpened(const QString &sessionId, const QString &title);

    // 2FA unlock challenge changed state (created->pending->approved/denied/
    // expired). The DeviceServer/desktop fan-out matches the existing pattern so
    // the desktop lock-gate unlocks the instant a paired phone approves.
    void authEvent(const QString &challengeId, const QString &state);

    // A fresh unlock challenge was minted — DeviceServer fans this out to authed
    // phones as an 'auth.challenge' event over the device WS so the phone surfaces
    // the Approve screen WITHOUT depending on Firebase/FCM.
    void authChallengePush(const QString &challengeId, const QString &origin, qint64 expiresAt);

private slots:
    void onNewConnection();
    void onTextMessage(const QString &message);
    void onSocketDisconnected();
    void onBrainEvent(const QString &sessionId, const jarvis::NormalizedBrainEvent &ev);
    // Flush a turn queued while the brain was busy (connected to Brain::turnFinished).
    void onTurnFinished(const QString &sessionId);

private:
    void handleRequest(QWebSocket *client, const Request &req);
    void sendResponse(QWebSocket *client, const Response &resp);
    void broadcastSessionEvent(const QString &sessionId, const NormalizedBrainEvent &ev);

    // Method handlers return a Response for the request id.
    Response handlePing(const Request &req);
    Response handleSettingsGet(const Request &req);
    Response handleSettingsSet(const Request &req);
    Response handleModelList(const Request &req);
    Response handleSessionCreate(const Request &req);
    Response handleSessionSend(const Request &req);
    Response handleSessionCancel(const Request &req);
    Response handleSessionDelete(const Request &req);
    Response handleSessionList(const Request &req);
    Response handleSessionHistory(const Request &req);
    // Session manager (Contract A): a client declares which session ids it is
    // currently viewing; the daemon then fans session.event frames ONLY for those
    // ids to it. Needs the socket, so it is dispatched with `client` (unlike the
    // req-only handlers). Empty list => the client wants NO session events (e.g. a
    // freshly-opened desktop sitting on an empty chat). This is what stops a Chrome
    // co-work session's transcript from leaking into the desktop.
    Response handleSessionSubscribe(QWebSocket *client, const Request &req);
    Response handleApprovalRespond(const Request &req);
    // The desktop tells the daemon which live-widget scope it is currently viewing
    // (a chat session, the Canvas tab = "all", or a popped-out "widget:<id>"), so an
    // unwatched live widget can idle to save battery. Keyed by the socket so the
    // lease is dropped when the desktop disconnects. ~15s heartbeats refresh it.
    Response handleWidgetViewing(QWebSocket *client, const Request &req);

    // Contract A v2 handlers.
    Response handleMcpList(const Request &req);
    Response handleMcpAdd(const Request &req);
    Response handleMcpRemove(const Request &req);
    Response handleMcpSetEnabled(const Request &req);
    Response handleMcpTest(const Request &req);
    // CLI MCP servers (the brains' OWN configs: ~/.claude.json / ~/.codex) — list
    // them per brain so the user can toggle specific ones back ON (default isolated).
    Response handleMcpCliList(const Request &req);
    Response handleMcpCliSetEnabled(const Request &req);
    // Google connectors framework (Calendar/Docs/Drive/Gmail). A connector is a
    // disabled-by-default stdio MCP server "google-<service>" whose OAuth creds
    // are stored as write-only secrets and injected via the row's env map.
    Response handleConnectorsList(const Request &req);
    Response handleConnectorsAdd(const Request &req);
    Response handlePluginsCatalog(const Request &req);
    Response handlePluginsInstall(const Request &req);
    Response handlePluginsSetEnabled(const Request &req);
    Response handlePluginsRemove(const Request &req);

    // Wave 7 install gating + sandboxed activation helpers.
    //   applyPluginEnable: on enable, wire the plugin's capability —
    //     - kind=mcp/both, stdio  -> launch SANDBOXED via PluginSandbox.
    //     - kind=mcp/both, http   -> add a URL+bearer MCP server to the registry.
    //     - kind=skill/both       -> drop the plugin's SKILL.md into the skills dir.
    //   applyPluginDisable: tear down the sandboxed PID / remove the MCP row.
    // Both are best-effort and audited; failures are returned to the caller.
    bool applyPluginEnable(const PluginManifest &m, QString *err);
    void applyPluginDisable(const PluginManifest &m);
    // The MCP-registry id derived for an http plugin (stable per plugin id).
    static QString pluginMcpServerId(const QString &pluginId);

    // Contract A v2 device pairing/management (surfaced in desktop Settings).
    Response handleDevicesPairStart(const Request &req);
    Response handleDevicesList(const Request &req);
    Response handleDevicesRevoke(const Request &req);

    // Wave 5: nested agent desktop status + real-session take-over.
    Response handleAgentDesktopInfo(const Request &req);
    Response handleTakeOverRequest(const Request &req);
    // Esc / "stop" on the take-over overlay: cancel WHATEVER session is currently
    // driving the real screen (not necessarily the caller's), so Esc always stops it.
    Response handleTakeOverCancel(const Request &req);

    // 2FA + fingerprint cross-device unlock (FEATURE).
    //   auth.request -> mint a challenge + FCM-push every paired phone; FAIL-OPEN
    //                   {state:"approved",paired:false} when NO device is paired.
    //   auth.status  -> the current challenge state (poll fallback).
    //   auth.deny    -> mark a challenge denied + fan out.
    // (auth.approve is phone-only — handled by DeviceServer::devAuthApprove.)
    Response handleAuthRequest(const Request &req);
    Response handleAuthStatus(const Request &req);
    Response handleAuthDeny(const Request &req);
    //   auth.verify_pin -> local PIN unlock fallback (salted-hash check).
    Response handleAuthVerifyPin(const Request &req);
    // Fan an auth.event {challenge_id,state} out to every control client (clone of
    // broadcastSessionEvent) so the desktop lock-gate unlocks instantly.
    void broadcastAuthEvent(const QString &challengeId, const QString &state);
    // Fan a session.opened {session_id,title} out to every control client (clone of
    // broadcastAuthEvent) so the desktop raises/focuses + navigates to the new chat.
    void broadcastSessionOpened(const QString &sessionId, const QString &title);

    // Contract A v3: memory (HERMES_FEATURES §1).
    Response handleMemoryList(const Request &req);
    Response handleMemorySearch(const Request &req);
    Response handleMemoryAdd(const Request &req);
    Response handleMemoryEdit(const Request &req);
    Response handleMemoryRemove(const Request &req);
    // Contract A v3: self-authored skills (HERMES_FEATURES §2).
    Response handleSkillsList(const Request &req);
    Response handleSkillsGet(const Request &req);
    Response handleSkillsCreate(const Request &req);
    Response handleSkillsInvoke(const Request &req);
    Response handleSkillsRemove(const Request &req);
    Response handleSkillsToday(const Request &req);

    // Wave 8: scheduler (cron/at) — schedule.create/list/set_enabled/remove.
    Response handleScheduleCreate(const Request &req);
    Response handleScheduleList(const Request &req);
    Response handleScheduleSetEnabled(const Request &req);
    Response handleScheduleRemove(const Request &req);
    // Wave 8: SSH allow-list + gated exec.
    Response handleSshAllowList(const Request &req);
    Response handleSshAllowAdd(const Request &req);
    Response handleSshAllowRemove(const Request &req);
    Response handleSshExec(const Request &req, bool remote);
    // Wave 8: audit log surface.
    Response handleAuditList(const Request &req);

    // Fire a scheduled job: create a session + send its prompt (Scheduler's
    // FireFn). Returns the new session id (empty on failure).
    QString fireScheduledJob(const ScheduleRow &row);

    // PROMPT-INJECTION GATING (BUILD_SPEC). Scan a user turn / page text for an
    // ApiBrain session; if risky, emit an 'approval' NormalizedBrainEvent, audit
    // it, notify, and return true (caller BLOCKS the turn until approval). For
    // CLI brains this only audits (they run their own tool loop). `text` is the
    // user's turn (+ any screenshot/page text the daemon can see).
    bool gateForInjection(const QString &sessionId, const QString &brain,
                          const QString &text);

    // The Mistral bearer for the Voxtral voice proxy: the SettingsStore "mistral"
    // secret (loaded from ~/.config/jarvis/mistral_api_key on start). Empty when
    // unconfigured (voice handlers then return an error).
    QString mistralKey() const;

    // Create + wire a brain for a session row. Returns nullptr on unknown brain.
    // `agentMcpOverrides` (args non-empty for coworker+agent) replaces the
    // global computer-use override with the per-session nested-desktop engine,
    // and carries the bearer env vars for the codex child.
    Brain *makeBrain(const SessionRow &row, const QString &cwdOverride,
                     const CodexMcpOverrides &agentMcpOverrides);

    // Codex MCP overrides that point the built-in computer-use at the nested
    // per-session engine (url + bearer-via-env-var) and keep any other enabled
    // servers. Bearers are emitted as `bearer_token_env_var=<NAME>` with the
    // value in CodexMcpOverrides::env (codex 0.135 rejects inline bearers).
    CodexMcpOverrides agentMcpOverridesFor(const AgentDesktopInfo &desk) const;

    // Claude `--mcp-config` JSON ({"mcpServers":{...}}) for a coworker session:
    //   - FromRegistry: every enabled MCP server (incl. built-in computer-use).
    //   - ForAgent(desk): computer-use pointed at the nested per-session engine.
    QString claudeMcpConfigFromRegistry() const;
    QString claudeMcpConfigForAgent(const AgentDesktopInfo &desk) const;

    // Memory injection (HERMES_FEATURES §1), applied for ALL brains:
    //   - prefetchMemoryBlock: top-k relevant memories rendered as a prompt
    //     block to PREPEND before the user's text on each turn.
    //   - syncTurnMemory: after a turn, persist a salient fact (best-effort
    //     heuristic) so memory grows even when the model doesn't call the tool.
    QString prefetchMemoryBlock(const QString &query);
    void syncTurnMemory(const QString &sessionId, const QString &userText);

    // Soft permission policy injected into the co-work preamble. Auto-ranks
    // tools high/medium/low by capability and tells the model to call ask_user
    // before acting at/above the user's configured permission_level. Returns a
    // clause to append after the co-work guide (empty when level == "low" and
    // no HIGH-risk confirm is wanted — but we always confirm the worst).
    QString permissionPolicyClause() const;

    // Render the base system block (memory) injected into ApiBrain's system
    // prompt at session.create time.
    QString memorySystemBlock();

    // Resolve a connector env value (a "secret:<key>" reference or a literal)
    // to the concrete value to inject into a brain's stdio MCP environment.
    // "secret:<key>" -> SettingsStore.apiKey(<key>); anything else is returned
    // as-is. Empty when the secret is unset (so a placeholder connector injects
    // nothing). Used by the codex + claude stdio env builders.
    QString resolveConnectorEnv(const QString &valueOrRef) const;

    Config m_config;
    QString m_controlToken;
    QString m_lastError;

    QWebSocketServer *m_wsServer = nullptr;
    SessionStore m_store;

    // Contract A v2 domain stores/registries. SettingsStore owns config.toml
    // prefs + secrets.json; the registries wrap the SessionStore SQLite tables
    // and own the non-storage behavior (real MCP test, codex injection, catalog
    // parsing). Created in start() once m_store is open.
    SettingsStore m_settings;
    // Live-widget viewer leases (who is watching which live widget) — gates the
    // engine's live-widget supervisor so an unwatched widget stops doing work.
    WidgetLeaseRegistry m_widgetLeases;
    std::unique_ptr<McpRegistry> m_mcp;
    std::unique_ptr<PluginRegistry> m_plugins;
    // Wave 7: sandboxed launcher for kind=mcp/both stdio plugins (systemd-run
    // --user --scope, confined by the plugin's granted permissions; teardown by
    // PID). Tracks live plugin PIDs for the lifetime of the daemon.
    PluginSandbox m_sandbox;

    // Contract C shared machinery: paired-device store + daemon ed25519
    // identity, short-lived pairing codes, and the FCM push sender. Owned here
    // and reused by the DeviceServer.
    DeviceRegistry m_deviceReg;
    PairingManager m_pairing;
    // 2FA + fingerprint cross-device unlock: in-memory, TTL~120s challenges minted
    // by auth.request, approved by a paired phone (possession+biometric).
    AuthChallengeStore m_authChallenges;
    std::unique_ptr<FcmSender> m_fcm;
    // Set by DeviceServer: true iff a phone is connected + authed over the device WS.
    std::function<bool()> m_authedDeviceProbe;
    // Epoch-ms until which a desktop unlock is auto-approved (granted by a deliberate
    // phone-app action). 0 = no grace.
    qint64 m_deviceAuthGraceUntil = 0;

    // Model-generated session titles: a cheap async Mistral chat call names the
    // session from its first user message (replaces the truncated placeholder).
    QNetworkAccessManager *m_titleNam = nullptr;
    QSet<QString> m_titleGenStarted;   // fire once per session
    void generateSessionTitle(const QString &sessionId, const QString &seed);

    // Wave 5 intelligence backend: Jarvis-level long-term memory (SQLite+FTS5)
    // and self-authored skills. Memory is prefetched/injected before every brain
    // turn and synced after; skills are invokable + self-authoring.
    MemoryStore m_memory;
    SkillStore m_skills;

    // Wave 8 co-worker ops backend: cron/at scheduler (fires session.create+send
    // via a QTimer tick), the SSH allow-list (gated ssh.exec), the audit log
    // (every tool/action with risk), the injection gate's notifier. All share
    // the same jarvis.db file via distinct connection names.
    Scheduler m_scheduler;
    SshAllowList m_sshAllow;
    AuditLog m_audit;
    NotifyService m_notify;
    // Sessions currently BLOCKED awaiting an injection-gate approval, mapped to
    // the held user turn (text + image paths) so an 'allow' can resume it.
    struct HeldTurn {
        QString text;
        QStringList images;
    };
    QHash<QString, HeldTurn> m_injectionHeld;
    // Turns the user sent while the brain was still busy; flushed on turnFinished
    // so a fast follow-up is never rejected as "brain is busy".
    QHash<QString, HeldTurn> m_pendingTurns;
    // Sessions that have already received the one-time co-work guidance preamble.
    QSet<QString> m_coworkGuided;

    // Wave 5: per-coworker(agent) nested desktops + their bound engines.
    AgentDesktop m_agentDesktops{AgentDesktop::Options{}};
    // sessionId set: real-session take-over currently active (overlay shown).
    QSet<QString> m_takeOverActive;
    // sessionIds whose nested desktop was AUTO-spawned (let_jarvis_use_computer)
    // for a non-co-work chat. These are torn down when the session goes idle so a
    // plain chat doesn't leak a compositor per turn; an EXPLICIT coworker+agent
    // desktop is NOT in this set and stays up for live-view/take-over.
    QSet<QString> m_autoComputerSessions;

    // Authenticated client sockets.
    QSet<QWebSocket *> m_clients;
    // Session-manager scoping. A client that has sent session.subscribe is "scoped":
    // it receives session.event frames ONLY for the ids in m_subscriptions[client].
    // Clients that never subscribe are NOT scoped and keep the legacy broadcast, so
    // older clients (and the separate phone DeviceServer channel) are unaffected.
    // This is the fix for "a Chrome co-work session shows up in the desktop chat".
    QSet<QWebSocket *> m_scopedClients;
    QHash<QWebSocket *, QSet<QString>> m_subscriptions;
    // sessionId -> live brain.
    QHash<QString, Brain *> m_brains;
};

} // namespace jarvis
