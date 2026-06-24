#pragma once

#include <QObject>
#include <QHash>
#include <QSet>
#include <QString>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

class QWebSocket;
class QNetworkAccessManager;
class QNetworkReply;
class QTimer;
class QFileSystemWatcher;
class QProcess;
class QAudioSource;
class QIODevice;
class QMediaPlayer;
class QAudioOutput;
class FrameProvider;

// Bridge: owns the Contract A control WebSocket to jarvisd.
//
//   ws://127.0.0.1:8795/control/ws?token=<~/.config/jarvis/control_token>
//
// Contract A messages are single JSON objects:
//   Request:  {"v":1,"id":<int>,"method":"<m>","params":{...}}
//   Response: {"v":1,"id":<int>,"ok":true,"result":{...}}
//             {"v":1,"id":<int>,"ok":false,"error":{"code","message"}}
//   Event:    {"v":1,"event":"session.event","data":{"session_id":"<id>","ev":<NormalizedBrainEvent>}}
//
// Contract B NormalizedBrainEvent is delivered to QML via sessionEvent(QVariantMap)
// with the session_id folded in under "session_id".
class Bridge : public QObject
{
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(bool connected READ isConnected NOTIFY connectedChanged)
    Q_PROPERTY(QString sessionId READ sessionId NOTIFY sessionIdChanged)
    Q_PROPERTY(QString status READ status NOTIFY statusChanged)

    // ---- COMPUTER page (Wave 5 co-worker / take-over) ----------------------
    // The active co-worker (target="agent") session driving the nested desktop.
    Q_PROPERTY(QString coworkerSessionId READ coworkerSessionId NOTIFY coworkerSessionIdChanged)
    // True while a REAL-screen take-over (target="real") is authorized & active.
    // The distinct-cursor overlay binds its visibility to this.
    Q_PROPERTY(bool driving READ driving NOTIFY drivingChanged)
    // True while the engine's agent-desktop mirror is being polled for frames.
    Q_PROPERTY(bool mirroring READ mirroring NOTIFY mirroringChanged)
    // Monotonic frame counter; bump source on change to defeat the QML cache.
    Q_PROPERTY(int frameSeq READ frameSeq NOTIFY frameReady)

    // Voice dictation indicator: "idle" | "recording" | "transcribing".
    Q_PROPERTY(QString recordingState READ recordingState NOTIFY recordingStateChanged)
    // Voice MODE orb state: "idle" | "listening" | "thinking" | "speaking".
    // Drives the VoiceMode.qml glowing orb's animation.
    Q_PROPERTY(QString voiceState READ voiceState NOTIFY voiceStateChanged)
    // Hands-free conversation mode: true while continuous listen (no hold-to-talk)
    // is active. Drives the VoiceMode button label.
    Q_PROPERTY(bool handsFree READ handsFree NOTIFY handsFreeChanged)
    // Desktop notifications (notify-send) toggle; persisted via settings.
    Q_PROPERTY(bool notify READ notificationsEnabled NOTIFY notificationsChanged)

public:
    explicit Bridge(QObject *parent = nullptr);
    ~Bridge() override;

    // Wire up the FrameProvider that QML pulls agent-desktop frames from. Called
    // from main.cpp after the provider is registered on the engine.
    void setFrameProvider(FrameProvider *provider) { m_frameProvider = provider; }

    bool isConnected() const { return m_connected; }
    QString sessionId() const { return m_sessionId; }
    QString status() const { return m_status; }
    QString coworkerSessionId() const { return m_coworkerSessionId; }
    bool driving() const { return m_driving; }
    bool mirroring() const { return m_mirroring; }
    int frameSeq() const { return m_frameSeq; }
    QString recordingState() const { return m_recordingState; }
    QString voiceState() const { return m_voiceState; }
    bool handsFree() const { return m_handsFree; }

    // Establish (or re-establish) the control WebSocket connection.
    Q_INVOKABLE void connectToDaemon();

    // session.create -> stashes the returned session_id on success.
    Q_INVOKABLE void createSession(const QString &profile,
                                   const QString &brain,
                                   const QString &model);

    // session.send for the current session.
    Q_INVOKABLE void sendMessage(const QString &text);

    // Answer a model ask_user question (writes the answer file the engine polls).
    Q_INVOKABLE void answerQuestion(const QString &id, const QString &answer);

    // session.cancel for the current session.
    Q_INVOKABLE void cancelSession();

    // approval.respond { decision: allow|deny|always }.
    Q_INVOKABLE void respondApproval(const QString &approvalId, const QString &decision);

    // model.list { brain } -> emits modelsListed on response.
    Q_INVOKABLE void listModels(const QString &brain);

    // voice.list_voices -> emits voicesListed(QVariantList) on response. Each row
    // is {id, label}; used by the Settings TTS voice picker.
    Q_INVOKABLE void listVoices();

    // ---- Contract A v2 ------------------------------------------------------
    // session.create with explicit profile/title plus optional callback routing.
    // Open an existing session by id (used from the Sessions page; loads history).
    Q_INVOKABLE void openSession(const QString &sessionId);

    // session.delete { session_id } -> on success emits sessionDeleted(id). If the
    // deleted session was the current one, clears it so the next send starts fresh.
    Q_INVOKABLE void deleteSession(const QString &sessionId);

    // Drop the current session id locally (no daemon round-trip) so the NEXT
    // sendMessage()/createSession() spins up a brand-new session. Used by the
    // desktop "+ New chat" affordance.
    Q_INVOKABLE void newSession();

    // settings.get -> settingsLoaded(QVariantMap).
    Q_INVOKABLE void loadSettings();
    // settings.set { patch } -> settingsSaved(); api key values are write-only.
    Q_INVOKABLE void saveSettings(const QVariantMap &patch);

    // mcp.* registry.
    Q_INVOKABLE void listMcp();
    Q_INVOKABLE void addMcp(const QVariantMap &server);
    Q_INVOKABLE void removeMcp(const QString &id);
    Q_INVOKABLE void setMcpEnabled(const QString &id, bool enabled);
    Q_INVOKABLE void testMcp(const QString &id);

    // mcp.cli_* — the per-brain CLI's OWN MCP servers (claude's ~/.claude.json,
    // codex's ~/.codex/config.toml). By default the brains run ISOLATED and do NOT
    // load these; toggling one on imports it into the Jarvis registry so it's
    // injected into the brains.
    // mcp.cli_list -> emits mcpCliListed(result.servers).
    Q_INVOKABLE void mcpCliList();
    // mcp.cli_set_enabled { brain, name, enabled } -> emits mcpCliChanged on success.
    Q_INVOKABLE void mcpCliSetEnabled(const QString &brain, const QString &name, bool enabled);

    // connectors.* — Google connectors framework (Calendar/Docs/Drive/Gmail).
    // connectors.list -> connectorsListed(QVariantList).
    Q_INVOKABLE void connectorsList();
    // connectors.add {service,client_id,client_secret,refresh_token} (creds may be
    // placeholders for the framework/mock) -> connectorsChanged() + re-list.
    Q_INVOKABLE void connectorAdd(const QString &service, const QString &clientId,
                                  const QString &clientSecret, const QString &refreshToken);

    // plugins.* marketplace.
    Q_INVOKABLE void loadPlugins();
    Q_INVOKABLE void installPlugin(const QString &id);
    Q_INVOKABLE void setPluginEnabled(const QString &id, bool enabled);
    Q_INVOKABLE void removePlugin(const QString &id);

    // session.list -> sessionsListed(QVariantList).
    Q_INVOKABLE void listSessions();
    // session.history { session_id } -> sessionHistory(sessionId, events).
    Q_INVOKABLE void loadSessionHistory(const QString &sessionId);

    // ---- Devices (Contract A v2 pairing, surfaced in Settings) --------------
    // devices.pair_start -> pairingStarted(qrSvg, code, payload, expiresAt).
    Q_INVOKABLE void devicesPairStart();
    // devices.list -> devicesListed(QVariantList).
    Q_INVOKABLE void devicesList();
    // devices.revoke { id } -> on success refreshes the list.
    Q_INVOKABLE void devicesRevoke(const QString &id);

    // ---- 2FA + fingerprint cross-device unlock (LockGate) ------------------
    // auth.request { origin } -> authChallengeStarted(challengeId, state, paired).
    // FAIL-OPEN: when no phone is paired the daemon answers state="approved",
    // paired=false so the gate unlocks immediately.
    Q_INVOKABLE void authRequest(const QString &origin = QStringLiteral("desktop"));
    // auth.status { challenge_id } -> authStateChanged(challengeId, state) (poll
    // fallback; the daemon also pushes an unsolicited auth.event on approval).
    Q_INVOKABLE void authStatus(const QString &challengeId);
    // auth.deny { challenge_id } — cancel a pending unlock from the desktop side.
    Q_INVOKABLE void authDeny(const QString &challengeId);

    // ---- Memory (Contract A v3) --------------------------------------------
    // memory.list { limit? } -> memoriesListed(QVariantList).
    Q_INVOKABLE void memoryList(int limit = 0);
    // memory.search { q } -> memoriesListed(QVariantList) (scored).
    Q_INVOKABLE void memorySearch(const QString &q);
    // memory.add { text, tags? } -> on success refreshes the list.
    Q_INVOKABLE void memoryAdd(const QString &text, const QStringList &tags);
    // memory.remove { id } -> on success refreshes the list.
    Q_INVOKABLE void memoryRemove(const QString &id);

    // ---- Skills (Contract A v3, self-authoring) ----------------------------
    // skills.list -> skillsListed(QVariantList).
    Q_INVOKABLE void skillsList();
    // skills.get { name } -> skillLoaded(name, frontmatter, body, path).
    Q_INVOKABLE void skillGet(const QString &name);
    // skills.create { name, description, body, group?, scripts? } — SELF-AUTHORING:
    // writes a SKILL.md to the skills dir; on success refreshes the list.
    Q_INVOKABLE void skillCreate(const QString &name, const QString &description,
                                 const QString &body, const QString &group);
    // skills.invoke { name, args? } -> skillInvoked(name, message). The rendered
    // skill text is meant to be injected into the chat as a user message.
    Q_INVOKABLE void skillInvoke(const QString &name, const QString &args);
    // skills.remove { name } -> on success refreshes the list.
    Q_INVOKABLE void skillRemove(const QString &name);

    // skills.today -> todayDigest(digest). A short "what I'm working on today"
    // summary built from project-tracker + recent sessions/memories.
    Q_INVOKABLE void skillsToday();

    // ---- Schedules (Contract A additions) ----------------------------------
    // schedule.list -> schedulesListed(QVariantList). Rows:
    //   {id,name,cron,next_run,last_run,enabled}.
    Q_INVOKABLE void scheduleList();
    // schedule.create{name,when|cron,prompt,brain?,model?,profile?,enabled?} -> {id}.
    // `when` is an optional natural cadence ("every day 09:00"); if `cron` is set it
    // wins. On success the list is refreshed.
    Q_INVOKABLE void scheduleCreate(const QVariantMap &spec);
    // schedule.set_enabled{id,enabled}; refreshes the list on success.
    Q_INVOKABLE void scheduleSetEnabled(const QString &id, bool enabled);
    // schedule.remove{id}; refreshes the list on success.
    Q_INVOKABLE void scheduleRemove(const QString &id);
    // schedule.run_now{id} — fire a due job immediately (best-effort).
    Q_INVOKABLE void scheduleRunNow(const QString &id);

    // ---- SSH allow-list + gated exec (Contract A additions) ----------------
    // ssh.allow_list -> sshHostsListed(QStringList).
    Q_INVOKABLE void sshAllowList();
    // ssh.allow_add{host}; refreshes the allow-list on success.
    Q_INVOKABLE void sshAllowAdd(const QString &host);
    // ssh.allow_remove{host}; refreshes the allow-list on success.
    Q_INVOKABLE void sshAllowRemove(const QString &host);
    // ssh.exec{host,cmd} -> sshExecResult(host,ok,output). The daemon enforces the
    // allow-list (error 'host_not_allowed') and the biometric tier; this only sends.
    Q_INVOKABLE void sshExec(const QString &host, const QString &cmd);

    // ---- Audit log (HERMES_FEATURES risk gate) -----------------------------
    // audit.list{limit?} -> auditListed(QVariantList). Rows:
    //   {ts,tool,ok,risk,summary}.
    Q_INVOKABLE void auditList(int limit = 100);

    // ---- Diff review actions (chat diff panel) -----------------------------
    // diff.stage / diff.commit / diff.revert / diff.open_pr {path?,message?} for the
    // active session. Best-effort: the daemon/brain may not implement these yet, so
    // results surface via diffActionResult and unknown_method degrades quietly.
    Q_INVOKABLE void diffStage(const QString &path);
    Q_INVOKABLE void diffRevert(const QString &path);
    Q_INVOKABLE void diffCommit(const QString &message);
    Q_INVOKABLE void diffOpenPr(const QString &title);

    // ---- Voice dictation (Mistral via daemon voice.stt/voice.tts) ----------
    // Record ~`seconds` of mic audio via pw-record (PipeWire) to a temp wav, then
    // call voice.stt and emit voiceTranscribed(text). recordingState tracks the UI
    // indicator. If pw-record is unavailable it emits errorOccurred.
    Q_INVOKABLE void voiceDictate(int seconds);
    // Stop an in-progress recording early and transcribe what was captured.
    Q_INVOKABLE void voiceDictateStop();
    // voice.tts{text,voice?,format?} -> writes the returned audio to a temp file and
    // plays it via pw-play/paplay; emits voiceSpeaking(true/false) around playback.
    Q_INVOKABLE void voiceSpeak(const QString &text);
    Q_INVOKABLE bool voiceAvailable() const;

    // ---- Voice MODE (the spinny-orb page) -----------------------------------
    // Push-to-talk capture via QtMultimedia (QAudioSource -> int16 mono 16k PCM
    // buffer). startListening() begins capture (voiceState=listening). stopListening()
    // finalizes the buffer into a WAV, base64s it, calls voice.stt, and on the reply
    // emits sttText() AND auto-sends the transcript to the voice session so the model
    // answers (voiceState=thinking). TTS replies flip voiceState to speaking, then
    // back to idle when playback ends. Speech playback uses QMediaPlayer/QAudioOutput.
    Q_INVOKABLE void startListening();
    Q_INVOKABLE void stopListening();
    // Hands-free conversation: continuous capture with energy-based voice-activity
    // detection. Speech is auto-finalized on a short silence and sent to voice.stt;
    // capture pauses while the model thinks + speaks, then resumes listening. No
    // hold-to-talk. stopConversation() ends it.
    Q_INVOKABLE void startConversation();
    Q_INVOKABLE void stopConversation();
    // Speak arbitrary text via voice.tts (voice = tts_voice setting or empty -> the
    // daemon default). Same QMediaPlayer playback path as the STT round-trip reply.
    Q_INVOKABLE void speak(const QString &text);
    // Ensure a dedicated voice coworker/coder session exists (so "what's on my
    // screen" can use the computer-use screenshot tool). Reuses createSession.
    Q_INVOKABLE void ensureVoiceSession();

    // ---- In-app browser (agent's controlled Chrome via the engine bridge) --
    // The desktop never embeds QtWebEngine; it drives the engine's browser tools
    // over the per-session computer-use engine and renders the returned screenshot.
    // browser.status -> browserStatus(url,title,canBack,canForward).
    Q_INVOKABLE void browserStatus();
    // browser.navigate{url}; browser.back/forward/reload; refreshes status+shot.
    Q_INVOKABLE void browserNavigate(const QString &url);
    Q_INVOKABLE void browserBack();
    Q_INVOKABLE void browserForward();
    Q_INVOKABLE void browserReload();
    // browser.screenshot -> browserShot(b64Png). Polled while the page is open.
    Q_INVOKABLE void browserScreenshot();
    // browser.snapshot -> browserSnapshot(QVariantList nodes) for click-by-ref.
    Q_INVOKABLE void browserSnapshot();
    // browser.click{ref} — click an element by its snapshot ref.
    Q_INVOKABLE void browserClick(const QString &ref);

    // ---- Sub-agent tree -----------------------------------------------------
    // session.list with parent links folded into a tree -> subAgentTree(QVariantList).
    // Reuses session.list; the page builds the indented tree from parent_session_id.
    Q_INVOKABLE void loadSubAgentTree();

    // ---- Notifications ------------------------------------------------------
    // Toggle desktop notify-send on attention events. Persisted via settings.set so
    // the daemon's NotifyService honors it too.
    Q_INVOKABLE void setNotificationsEnabled(bool enabled);
    Q_INVOKABLE bool notificationsEnabled() const { return m_notify; }
    // Fire a desktop notification now (notify-send), used for client-side attention
    // cues (approval needed / schedule done) when the daemon does not push them.
    Q_INVOKABLE void notify(const QString &title, const QString &body);

    // ---- COMPUTER page (co-worker session + take-over + live video) --------
    // Start a co-worker session: session.create{profile:"coworker",target:"agent"}.
    // jarvisd spawns the nested headless desktop + a per-session computer-use
    // engine; on success the returned session_id becomes coworkerSessionId and
    // the agent-desktop mirror auto-starts. The new session also becomes the
    // current sessionId so the COMPUTER page's transcript renders its events.
    Q_INVOKABLE void startCoworker(const QString &brain, const QString &model);
    // Stop / cancel the active co-worker session and its mirror.
    Q_INVOKABLE void stopCoworker();

    // Request a REAL-screen take-over: session.create{profile:"coworker",
    // target:"real"}. This is biometric/approval-gated by the daemon; when the
    // daemon confirms the take-over is live it pushes a driving.state event which
    // flips `driving` true and arms the distinct-cursor overlay.
    Q_INVOKABLE void takeOver(const QString &brain, const QString &model);
    // End a real-screen take-over (release the user's screen).
    Q_INVOKABLE void releaseScreen();

    // Cancel an active take-over from the overlay (Esc on the DrivingOverlay, or
    // the in-page "Esc to cancel"). Sends control-WS `take_over.cancel`
    // (best-effort; the daemon may not implement it yet) AND flips `driving` false
    // locally so the overlay is dropped immediately. This is the Esc-to-cancel
    // path required by docs/TAKEOVER_UX.md.
    Q_INVOKABLE void takeOverCancel();

    // ---- Driving DEMO (screenshot / visual verification) -------------------
    // Force the take-over overlay visible and animate a FAKE agent pointer along a
    // looping path (no live take-over needed). Used by `--driving-demo` and the
    // ComputerPage preview so the overlay can be rendered/verified standalone.
    Q_INVOKABLE void startDrivingDemo();
    // Stop the fake-pointer animation and drop the demo overlay.
    Q_INVOKABLE void stopDrivingDemo();

    // mirror.start / mirror.stop — biometric-gated on the device channel, but the
    // desktop drives its own local preview by polling the per-session engine's
    // GET /video/frame. These toggle that local polling loop.
    Q_INVOKABLE void mirrorStart();
    Q_INVOKABLE void mirrorStop();

    // Point the local video poller at a specific engine base URL (e.g.
    // "http://127.0.0.1:8810"). jarvisd reports this in the session.create result
    // (engine_url); if absent we fall back to the per-session-port convention.
    Q_INVOKABLE void setVideoEndpoint(const QString &baseUrl);

    // Pull one agent-desktop frame now (used by the poll timer; also callable
    // from QML for an on-demand refresh).
    Q_INVOKABLE void pollFrame();

    // ---- Generative widgets (CANVAS page) ----------------------------------
    // "Pop out" a rendered widget into a standalone frameless always-on-top
    // desktop window. Packages {id,title,spec} and emits spawnStandaloneWidget so
    // QML can instantiate a StandaloneWidget Window (window lifetime stays in QML,
    // mirroring the driving-overlay Instantiator). Routing through Bridge keeps a
    // single owner and lets a future engine-driven "pop out" reuse the same path.
    Q_INVOKABLE void popOutWidget(const QString &id, const QString &title,
                                  const QVariant &spec);

signals:
    void connectedChanged();
    void sessionIdChanged();
    void statusChanged();

    // A NormalizedBrainEvent (Contract B) for a session, with session_id folded in.
    void sessionEvent(const QVariantMap &event);

    // Result of model.list.
    void modelsListed(const QString &brain, const QStringList &models);

    // Result of voice.list_voices: rows of {id, label} for the TTS picker.
    void voicesListed(const QVariantList &voices);
    // Per-provider extras from voice.list_voices (emitted from the same reply):
    // STT/TTS provider rows ({id,label,available}) and a {provider: [voices]} map
    // so the picker can switch provider client-side without a round-trip.
    void voiceProvidersListed(const QVariantList &sttProviders,
                              const QVariantList &ttsProviders,
                              const QVariantMap &voicesByProvider);

    // ---- Contract A v2 results ---------------------------------------------
    void settingsLoaded(const QVariantMap &settings);
    void settingsSaved();
    void mcpListed(const QVariantList &servers);
    void mcpTested(const QString &id, bool ok, int toolsCount, const QString &error);
    void mcpChanged();   // emitted after add/remove/set_enabled so the UI refreshes
    // The per-brain CLI MCP servers from mcp.cli_list. Rows:
    //   {brain:"claude"|"codex", name, transport:"http"|"stdio", endpoint, enabled}.
    void mcpCliListed(const QVariantList &servers);
    // Emitted after mcp.cli_set_enabled so the UI re-queries the CLI server list.
    void mcpCliChanged();
    void pluginsListed(const QVariantList &plugins);
    void pluginsChanged();
    // Google connectors (connectors.list rows: {id,name,service,enabled,risk,
    // has_client_id,has_client_secret,has_refresh_token}).
    void connectorsListed(const QVariantList &connectors);
    void connectorsChanged(); // emitted after connectors.add so the UI refreshes
    void sessionsListed(const QVariantList &sessions);
    void sessionHistory(const QString &sessionId, const QVariantList &events);
    // Fired when openSession finishes wiring a chosen session as current.
    void sessionOpened(const QString &sessionId);
    // Fired when a FOREIGN session opened but the desktop already has an active chat:
    // surface/raise the window WITHOUT switching or clearing the current transcript.
    void sessionFocusRequested();
    // Fired when a session.delete succeeds; the Sessions page refreshes its list.
    void sessionDeleted(const QString &sessionId);

    // ---- Devices pairing results -------------------------------------------
    // devices.pair_start result: the raw qr_svg markup, the 6-digit code, the
    // full jarvis://pair?... payload, and the epoch-seconds expiry.
    void pairingStarted(const QString &qrSvg, const QString &code,
                        const QString &payload, double expiresAt);
    void devicesListed(const QVariantList &devices);
    void devicesChanged();   // emitted after a revoke so the UI refreshes

    // ---- 2FA + fingerprint cross-device unlock (LockGate) ------------------
    // auth.request result: the minted challenge id, its state ("pending" or, when
    // FAIL-OPEN / no phone paired, "approved"), and whether a phone is paired.
    void authChallengeStarted(const QString &challengeId, const QString &state,
                              bool paired);
    // The challenge changed state — from an auth.status poll OR the unsolicited
    // auth.event push. "approved" unlocks the gate; "denied"/"expired" -> retry.
    void authStateChanged(const QString &challengeId, const QString &state);

    // ---- Memory results (Contract A v3) ------------------------------------
    // memory.list / memory.search both resolve here. `isSearch` lets the UI tell
    // a scored search result from a full list. Rows: {id,text,tags,created,score?}.
    void memoriesListed(const QVariantList &memories, bool isSearch);
    // Emitted after add/remove so the page can re-query.
    void memoryChanged();

    // ---- Skills results (Contract A v3) ------------------------------------
    // Rows: {name,group,description,tags,self_authored}.
    void skillsListed(const QVariantList &skills);
    // skills.get result.
    void skillLoaded(const QString &name, const QVariantMap &frontmatter,
                     const QString &body, const QString &path);
    // Emitted after create/remove so the page can re-query.
    void skillsChanged();
    // skills.invoke result — the rendered skill text to inject into chat.
    void skillInvoked(const QString &name, const QString &message);
    // skills.today result.
    void todayDigest(const QString &digest);

    // ---- Schedules results --------------------------------------------------
    void schedulesListed(const QVariantList &schedules);
    void schedulesChanged();   // emitted after create/remove/set_enabled

    // ---- SSH results --------------------------------------------------------
    void sshHostsListed(const QStringList &hosts);
    void sshHostsChanged();    // emitted after allow_add/remove
    void sshExecResult(const QString &host, bool ok, const QString &output);

    // ---- Audit results ------------------------------------------------------
    void auditListed(const QVariantList &entries);

    // ---- Diff review results ------------------------------------------------
    void diffActionResult(const QString &action, const QString &path,
                          bool ok, const QString &message);

    // ---- Voice dictation results --------------------------------------------
    // recording state for the mic indicator: "idle"|"recording"|"transcribing".
    void recordingStateChanged();
    // Final transcript ready to drop into the input.
    void voiceTranscribed(const QString &text);
    // TTS playback bracket (true=started, false=finished).
    void voiceSpeaking(bool active);

    // ---- Voice MODE (orb) ---------------------------------------------------
    // Orb state changed: idle|listening|thinking|speaking.
    void voiceStateChanged();
    void handsFreeChanged();
    // The transcript of a push-to-talk capture (also auto-sent to the session).
    void sttText(const QString &text);

    // ---- In-app browser results ---------------------------------------------
    void browserStatusReady(const QString &url, const QString &title,
                            bool canBack, bool canForward);
    // Latest browser screenshot as a base64 PNG (no data: prefix).
    void browserShot(const QString &b64Png);
    void browserSnapshotReady(const QVariantList &nodes);

    // ---- Sub-agent tree -----------------------------------------------------
    // Flattened, ordered tree rows: {id,title,brain,status,depth,parent}.
    void subAgentTree(const QVariantList &rows);

    // ---- Notifications ------------------------------------------------------
    void notificationsChanged();

    // ---- COMPUTER page signals ---------------------------------------------
    void coworkerSessionIdChanged();
    void drivingChanged();
    void mirroringChanged();
    // Fired when a co-worker session is fully created (nested desktop spawning).
    void coworkerStarted(const QString &sessionId);
    // A take-over was requested; the daemon's approval flow is now pending.
    void takeOverRequested(const QString &sessionId);
    // A new agent-desktop frame is in the FrameProvider; QML bumps its Image
    // source to "image://jarvisframe/agent?<seq>" to render it.
    void frameReady(int seq);
    // The agent's intended pointer (Wave 5 event bus): screen-normalized x,y in
    // [0,1] plus the action ("move"|"click"|"drag"|"scroll") and button. The
    // distinct-cursor overlay tracks this while `driving`.
    void agentPointer(double nx, double ny, const QString &action,
                      const QString &button);

    // The agent's intended pointer in GLOBAL desktop pixels (full multi-monitor
    // virtual desktop). The take-over overlay (one surface per output) subtracts
    // its monitor's origin to get a local position and HIDES the glow when the
    // point is on another monitor. Emitted alongside agentPointer.
    void agentPointerGlobal(double gx, double gy, const QString &action,
                            const QString &button);

    // The model asked the user a question (ask_user MCP tool). The chat shows a
    // card with the options; answerQuestion() sends the choice back to the model.
    void agentQuestion(const QString &id, const QString &question,
                       const QStringList &options);

    // The model rendered a custom widget (render_widget MCP tool, file bus
    // ~/.local/share/jarvis/widgets.jsonl). `widget` = {ts, title, id, spec} with
    // `spec` a nested QVariantMap/QVariantList. The CANVAS page draws it via the
    // WidgetRenderer JSON-DSL interpreter (never eval). `id` lets the page replace
    // a card in place when the model re-renders by id (update-by-id).
    void widgetRendered(const QVariantMap &widget);

    // A widget was "popped out" of the CANVAS page (popOutWidget). `widget` =
    // {id, title, spec}; Main.qml's Instantiator spawns a StandaloneWidget Window
    // for it (frameless, always-on-top), which also live-updates when a later
    // widgetRendered() arrives with the same id.
    void spawnStandaloneWidget(const QVariantMap &widget);

    // Surfaced protocol/transport errors for the UI.
    void errorOccurred(const QString &message);

private slots:
    void onConnected();
    void onDisconnected();
    void onTextMessageReceived(const QString &message);
    void onSocketError();

private:
    int nextId();
    void send(const QString &method, const QVariantMap &params, int id);
    int request(const QString &method, const QVariantMap &params,
                const QString &ctx = QString());
    void setStatus(const QString &s);
    void handleResponse(int id, bool ok, const QVariantMap &result, const QVariantMap &error);

    // COMPUTER page helpers.
    void setDriving(bool d);
    void setMirroring(bool m);
    void setCoworkerSessionId(const QString &id);
    // Route control-channel events that the COMPUTER page consumes (agent_pointer,
    // driving.state). Returns true if the event was a computer-page event.
    bool handleComputerEvent(const QString &sessionId, const QVariantMap &ev);
    void onFrameReplyFinished(QNetworkReply *reply);
    QString videoFrameUrl() const;
    // Tail ~/.local/share/jarvis/agent_pointer.jsonl as a fallback source for the
    // agent-pointer bus when the daemon does not forward it over the control WS.
    void startPointerTail();
    void stopPointerTail();
    void readPointerTail();

    // Watch ~/.local/share/jarvis/questions/ for ask_user question files and
    // surface them as agentQuestion(); answerQuestion() writes the .answer file.
    void startQuestionWatch();
    void scanQuestions();
    QString questionsDir() const;

    // Poll ~/.local/share/jarvis/widgets.jsonl (render_widget file bus) for new
    // lines, tracking the last byte offset (a watcher on an appended file can
    // miss events), and emit widgetRendered() for each parsed record.
    void startWidgetWatch();
    void readWidgetTail();
    QString widgetsPath() const;

    // Driving-demo fake pointer: advance the looping path one step and emit it.
    void tickDrivingDemo();

    // ---- Voice helpers ------------------------------------------------------
    void setRecordingState(const QString &s);
    void finishDictation();          // record stopped -> read wav -> voice.stt
    QString recordWavPath() const;   // temp wav path for the active capture
    static bool hasExecutable(const QString &name);

    // ---- Voice MODE helpers -------------------------------------------------
    void setVoiceState(const QString &s);
    // Wrap raw int16 mono PCM (m_voicePcm) in a 44-byte WAV header.
    QByteArray pcmToWav(const QByteArray &pcm, int sampleRate, int channels) const;
    // Decode TTS audio_b64 -> temp file -> play via QMediaPlayer (sets speaking).
    void playTtsAudio(const QByteArray &audio, const QString &mime);

    // ---- Sub-agent tree builder --------------------------------------------
    // Build an indented tree (depth + parent) from a flat session.list result.
    QVariantList buildSubAgentTree(const QVariantList &sessions) const;

    // ---- Browser helpers (per-session engine HTTP) --------------------------
    // POST a browser tool to the engine and route the reply to a handler tag.
    void engineBrowserCall(const QString &tag, const QVariantMap &body);
    QString engineBase() const;

    static QString readControlToken();
    static QString controlUrl();
    static QString computeUseBearer();

    QWebSocket *m_socket = nullptr;
    bool m_connected = false;
    int m_idCounter = 0;
    QString m_sessionId;
    QString m_status = QStringLiteral("disconnected");
    // A chat message typed before any session existed; the auto-created session's
    // session.create response flushes it (no-buttons first-turn send).
    QString m_pendingText;

    // Maps request id -> the method that originated it, so responses can be routed.
    QHash<int, QString> m_pending;
    // Optional per-request context (e.g. the mcp id for mcp.test, the session id
    // for session.history) so async results can be tagged on completion.
    QHash<int, QString> m_pendingCtx;
    // True while a session opened from the Sessions page is being loaded, so the
    // history response can be surfaced as a chat load rather than a list refresh.
    bool m_openingSession = false;

    // ---- COMPUTER page state ------------------------------------------------
    QString m_coworkerSessionId;
    bool m_driving = false;
    bool m_mirroring = false;
    int m_frameSeq = 0;

    // Live-video poller (per-session computer-use engine GET /video/frame).
    FrameProvider *m_frameProvider = nullptr;
    QNetworkAccessManager *m_net = nullptr;
    QNetworkReply *m_frameReply = nullptr;
    QTimer *m_frameTimer = nullptr;
    QString m_videoBase;     // engine base url, e.g. http://127.0.0.1:8810
    QString m_videoBearer;   // cached computer-use bearer (from config.yaml)

    // agent_pointer.jsonl fallback tail.
    QFileSystemWatcher *m_pointerWatcher = nullptr;
    qint64 m_pointerOffset = 0;
    // Overlay auto-arm: true when driving was turned on by REAL-screen pointer
    // activity (not an explicit take-over), so the idle timer may turn it back off.
    bool m_drivingAutoArmed = false;
    QTimer *m_realIdleTimer = nullptr;

    // ask_user question files watcher (+ ids already surfaced, to dedupe).
    QFileSystemWatcher *m_questionWatcher = nullptr;
    QSet<QString> m_seenQuestions;

    // render_widget file-bus poller (widgets.jsonl) + last byte offset.
    QTimer *m_widgetTimer = nullptr;
    qint64 m_widgetOffset = 0;

    // Driving-demo fake-pointer animation.
    QTimer *m_demoTimer = nullptr;
    double m_demoPhase = 0.0;     // advances each tick; drives the lissajous path
    int m_demoStep = 0;          // frame counter, used to schedule fake clicks
    bool m_demo = false;         // true while the demo (not a real take-over) drives

    // ---- Voice dictation (pw-record -> voice.stt; voice.tts -> pw-play) ------
    QString m_recordingState = QStringLiteral("idle");
    QProcess *m_recProc = nullptr;      // active pw-record capture
    QString m_recPath;                  // wav path for the active capture
    bool m_recAutoStop = false;         // a duration timer will stop the capture
    bool m_ttsRequested = false;        // a voice.tts is in flight (route the reply)

    // ---- Voice MODE (QtMultimedia capture + playback, orb state) ------------
    QString m_voiceState = QStringLiteral("idle");
    QString m_ttsVoice;                 // preferred TTS slug (from settings.get)
    QString m_sttProvider = QStringLiteral("voxtral"); // STT provider (settings.get)
    QString m_ttsProvider = QStringLiteral("voxtral"); // TTS provider (settings.get)
    // Capture: QAudioSource pulls int16 mono 16k PCM into m_voiceIo's buffer.
    QAudioSource *m_audioSource = nullptr;
    QIODevice *m_voiceIo = nullptr;     // the QAudioSource pull device (owned by it)
    QByteArray m_voicePcm;              // captured PCM accumulated here
    bool m_listening = false;
    // Playback (TTS): one player+output reused across utterances.
    QMediaPlayer *m_ttsPlayer = nullptr;
    QAudioOutput *m_ttsOutput = nullptr;
    QString m_ttsTmpPath;              // last decoded TTS file (kept until next play)
    // The dedicated voice session id (coworker/coder), so "what's on my screen"
    // works. Mirrors m_sessionId once created; we (re)use createSession.
    QString m_voiceSessionId;
    // True while a voice-mode STT turn is in flight, so the transcript reply is
    // auto-sent to the session (distinct from the chat-page dictation path).
    bool m_voiceModeStt = false;

    // ---- Hands-free conversation (energy VAD over the capture buffer) -------
    bool m_handsFree = false;          // continuous-listen mode active
    bool m_vadSpeech = false;          // speech currently detected in this utterance
    bool m_vadPaused = false;          // capture parked while model thinks/speaks
    qint64 m_vadSilenceBytes = 0;      // trailing silence accumulated since last speech
    qint64 m_vadSpeechBytes = 0;       // voiced bytes in the current utterance
    QTimer *m_vadWatchdog = nullptr;   // resume-listening fallback if no TTS arrives
    void handsFreeFeed(const QByteArray &chunk);  // VAD step on a capture chunk
    void resumeListening();            // clear buffers + go back to listening

    // ---- Notifications ------------------------------------------------------
    bool m_notify = true;               // mirror of settings.notifications.enabled
};
