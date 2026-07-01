#pragma once

#include <QObject>
#include <QHash>
#include <QSet>
#include <QString>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

class QJsonObject;
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
    // Agent mode (plan|build|coworker) — live for the HUD chip; WRITE persists it.
    Q_PROPERTY(QString agentMode READ agentMode WRITE setAgentMode NOTIFY agentModeChanged)

    // ---- COMPUTER page (Wave 5 co-worker / take-over) ----------------------
    // The active co-worker (target="agent") session driving the nested desktop.
    Q_PROPERTY(QString coworkerSessionId READ coworkerSessionId NOTIFY coworkerSessionIdChanged)
    // True while a REAL-screen take-over (target="real") is authorized & active.
    // The distinct-cursor overlay binds its visibility to this.
    Q_PROPERTY(bool driving READ driving NOTIFY drivingChanged)
    // True while the engine's agent-desktop mirror is being polled for frames.
    Q_PROPERTY(bool mirroring READ mirroring NOTIFY mirroringChanged)
    // True when the CURRENT session has a nested agent desktop (auto computer-use
    // or explicit co-work) — lets the in-chat peek mirror it live for ANY chat,
    // not only explicit co-worker sessions.
    Q_PROPERTY(bool hasAgentDesktop READ hasAgentDesktop NOTIFY hasAgentDesktopChanged)
    // Monotonic frame counter; bump source on change to defeat the QML cache.
    Q_PROPERTY(int frameSeq READ frameSeq NOTIFY frameReady)

    // Voice dictation indicator: "idle" | "recording" | "transcribing".
    Q_PROPERTY(QString recordingState READ recordingState NOTIFY recordingStateChanged)
    // Voice-clone library recorder state: "idle" | "recording" | "saving".
    Q_PROPERTY(QString voiceCloneState READ voiceCloneState NOTIFY voiceCloneStateChanged)
    // Voice MODE orb state: "idle" | "listening" | "thinking" | "speaking".
    // Drives the VoiceMode.qml glowing orb's animation.
    Q_PROPERTY(QString voiceState READ voiceState NOTIFY voiceStateChanged)
    // Hands-free conversation mode: true while continuous listen (no hold-to-talk)
    // is active. Drives the VoiceMode button label.
    Q_PROPERTY(bool handsFree READ handsFree NOTIFY handsFreeChanged)
    // Live mic input level (0..1) while listening — lets the orb react to the user's
    // voice so it's obvious capture is working (or not).
    Q_PROPERTY(qreal voiceLevel READ voiceLevel NOTIFY voiceLevelChanged)
    // Desktop notifications (notify-send) toggle; persisted via settings.
    Q_PROPERTY(bool notify READ notificationsEnabled NOTIFY notificationsChanged)

    // ---- System stats (REAL, polled from /proc + nvidia-smi) ---------------
    // Drive the HUD strip + the Home live-widgets dashboard with actual numbers
    // (not a simulated random-walk). Polled ~every 1.5 s on a single timer.
    Q_PROPERTY(qreal cpuPercent READ cpuPercent NOTIFY statsChanged)
    Q_PROPERTY(qreal ramPercent READ ramPercent NOTIFY statsChanged)
    Q_PROPERTY(qreal ramUsedGb READ ramUsedGb NOTIFY statsChanged)
    Q_PROPERTY(qreal ramTotalGb READ ramTotalGb NOTIFY statsChanged)
    Q_PROPERTY(qreal netUpMbps READ netUpMbps NOTIFY statsChanged)
    Q_PROPERTY(qreal netDownMbps READ netDownMbps NOTIFY statsChanged)
    Q_PROPERTY(bool gpuPresent READ gpuPresent NOTIFY statsChanged)
    Q_PROPERTY(qreal gpuPercent READ gpuPercent NOTIFY statsChanged)
    Q_PROPERTY(QString gpuName READ gpuName NOTIFY statsChanged)
    Q_PROPERTY(qreal gpuMemUsedMb READ gpuMemUsedMb NOTIFY statsChanged)
    Q_PROPERTY(qreal gpuMemTotalMb READ gpuMemTotalMb NOTIFY statsChanged)

public:
    explicit Bridge(QObject *parent = nullptr);
    ~Bridge() override;

    // Wire up the FrameProvider that QML pulls agent-desktop frames from. Called
    // from main.cpp after the provider is registered on the engine.
    void setFrameProvider(FrameProvider *provider) { m_frameProvider = provider; }

    bool isConnected() const { return m_connected; }
    QString sessionId() const { return m_sessionId; }
    QString status() const { return m_status; }
    QString agentMode() const { return m_agentMode; }
    QString coworkerSessionId() const { return m_coworkerSessionId; }
    bool driving() const { return m_driving; }
    bool mirroring() const { return m_mirroring; }
    bool hasAgentDesktop() const { return m_hasAgentDesktop; }
    int frameSeq() const { return m_frameSeq; }
    QString recordingState() const { return m_recordingState; }
    QString voiceCloneState() const { return m_voiceCloneState; }
    QString voiceState() const { return m_voiceState; }
    bool handsFree() const { return m_handsFree; }
    qreal voiceLevel() const { return m_voiceLevel; }

    qreal cpuPercent() const { return m_cpuPercent; }
    qreal ramPercent() const { return m_ramPercent; }
    qreal ramUsedGb() const { return m_ramUsedGb; }
    qreal ramTotalGb() const { return m_ramTotalGb; }
    qreal netUpMbps() const { return m_netUpMbps; }
    qreal netDownMbps() const { return m_netDownMbps; }
    bool gpuPresent() const { return m_gpuPresent; }
    qreal gpuPercent() const { return m_gpuPercent; }
    QString gpuName() const { return m_gpuName; }
    qreal gpuMemUsedMb() const { return m_gpuMemUsedMb; }
    qreal gpuMemTotalMb() const { return m_gpuMemTotalMb; }

    // Establish (or re-establish) the control WebSocket connection.
    Q_INVOKABLE void connectToDaemon();

    // session.create -> stashes the returned session_id on success.
    Q_INVOKABLE void createSession(const QString &profile,
                                   const QString &brain,
                                   const QString &model);

    // Start a fresh chat session that runs AS a custom agent: the daemon resolves
    // the agent's brain/model/profile and injects its system prompt. Backs the
    // "/agent <name>" slash command.
    Q_INVOKABLE void startAgentChat(const QString &agent);

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

    // ---- Auto-updater (update.* Contract A) --------------------------------
    // update.check -> updateChecked(current,latest,behind,version,reason). The
    // Settings "Check for updates" button calls this.
    Q_INVOKABLE void checkForUpdates();
    // update.apply -> updateApplied(updated,to,reason). Called from the "Update
    // now" affordance after a check reports an available update.
    Q_INVOKABLE void applyUpdate();

    // ---- Browser-extension guide -------------------------------------------
    // Chrome blocks silently installing an unpacked extension, so we ship it at a
    // known path and the Settings → "Add the Chrome extension" guide gives
    // one-click helpers to load it (chrome://extensions → Load unpacked).
    Q_INVOKABLE QString extensionPath() const;
    Q_INVOKABLE void openExtensionsPage();   // launch a Chromium browser at chrome://extensions
    Q_INVOKABLE void openExtensionFolder();  // open the bundled extension dir
    Q_INVOKABLE void copyToClipboard(const QString &text);

    // Persist + locally apply the agent mode (plan|build|coworker). Doubles as the
    // agentMode property WRITE so QML can two-way bind or call it directly.
    Q_INVOKABLE void setAgentMode(const QString &mode);

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
    // auth.verify_pin { challenge_id, pin } -> authStateChanged(...,"approved") on
    // success, pinRejected() on a wrong PIN. The reliable local unlock fallback.
    Q_INVOKABLE void verifyPin(const QString &challengeId, const QString &pin);

    // ---- Memory (Contract A v3) --------------------------------------------
    // memory.list { limit? } -> memoriesListed(QVariantList).
    Q_INVOKABLE void memoryList(int limit = 0);
    // memory.search { q } -> memoriesListed(QVariantList) (scored).
    Q_INVOKABLE void memorySearch(const QString &q);
    // memory.add { text, tags? } -> on success refreshes the list.
    Q_INVOKABLE void memoryAdd(const QString &text, const QStringList &tags);
    // memory.remove { id } -> on success refreshes the list.
    Q_INVOKABLE void memoryRemove(const QString &id);
    // memory.graph { root?, depth? } -> memoryGraphLoaded({nodes,edges}). Empty
    // root gets the default subgraph (all entities + their linked memories).
    Q_INVOKABLE void memoryGraph(const QString &root = QString(), int depth = 2);
    // memory.entities.list { limit? } -> memoryEntitiesListed(QVariantList).
    Q_INVOKABLE void memoryEntitiesList(int limit = 0);
    // memory.entity.get { id } -> memoryEntityLoaded({...entity, related:[...]}).
    Q_INVOKABLE void memoryEntityGet(const QString &id);
    // memory.link { from, to, relation? } -> on success refreshes the graph.
    Q_INVOKABLE void memoryLink(const QString &fromId, const QString &toId,
                               const QString &relation = QString());

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

    // ---- Agents (custom subagents) -----------------------------------------
    // agents.list -> agentsListed(QVariantList) — each {name,description,
    // when_to_use,brain,model,profile,tools,color,path}.
    Q_INVOKABLE void agentsList();
    // agents.get { name } -> agentLoaded(name, frontmatter, systemPrompt, path).
    Q_INVOKABLE void agentGet(const QString &name);
    // agents.create — writes an AGENT.md; on success refreshes the list.
    Q_INVOKABLE void agentCreate(const QString &name, const QString &description,
                                 const QString &whenToUse, const QString &systemPrompt,
                                 const QString &brain, const QString &model,
                                 const QString &profile);
    // agents.remove { name } -> on success refreshes the list.
    Q_INVOKABLE void agentRemove(const QString &name);
    // agents.dispatch { agent, task, parent_session_id? } -> agentDispatched(sid,agent).
    // Spawns a child session that runs as the agent; opens to it on success.
    Q_INVOKABLE void agentDispatch(const QString &name, const QString &task);

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

    // ---- Named voice library (record/upload, name, set-default) -------------
    // Record ~`seconds` of mic (pw-record -> temp wav) as a candidate reference
    // clip; on finish emits voiceClipCaptured(bytes, "wav") and voiceCloneState
    // goes idle. stopVoiceCloneRecording() ends it early. loadVoiceClipFromFile()
    // takes an uploaded clip instead. saveVoiceClone() sends the captured/loaded
    // clip to voice.create_clone (clean=true runs the ffmpeg trim/clean server-side).
    Q_INVOKABLE void recordVoiceClone(int seconds = 20);
    Q_INVOKABLE void stopVoiceCloneRecording();
    Q_INVOKABLE void loadVoiceClipFromFile(const QString &fileUrl);
    Q_INVOKABLE bool hasVoiceClip() const { return !m_voiceClipBytes.isEmpty(); }
    Q_INVOKABLE void saveVoiceClone(const QString &name, bool clean = true);
    // Library management (all drive the daemon voice.* methods + refresh the list).
    Q_INVOKABLE void setDefaultVoice(const QString &voiceId);
    Q_INVOKABLE void deleteVoiceClone(const QString &id);
    Q_INVOKABLE void renameVoiceClone(const QString &id, const QString &name);
    // Synthesize a short sample in `voiceId` and play it (voice.preview_clone).
    Q_INVOKABLE void previewVoice(const QString &voiceId);

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
    // Ask the chat UI to start a fresh chat (emitted on launch/toggle-to-visible).
    void requestNewChat() { emit newChatRequested(); }
    // Voice MODE brain/model selection (mirrors the chat picker). Set before the
    // voice session is created; resetVoiceSession() drops it so a new brain applies.
    Q_INVOKABLE void setVoicePreferences(const QString &brain, const QString &model)
    {
        m_voiceBrain = brain;
        m_voiceModel = model;
    }
    Q_INVOKABLE void resetVoiceSession();
    // Voice-mode OUTPUT (speaker) selection. audioOutputs() -> [{index,name,isDefault}];
    // setTtsOutput(index) routes TTS playback to that sink (index < 0 = system default).
    Q_INVOKABLE QVariantList audioOutputs() const;
    Q_INVOKABLE void setTtsOutput(int index);

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

    // ---- Phone (Contract A phone.mcp proxy) ---------------------------------
    // Forward a phone-server MCP tool call through the daemon's phone.mcp method.
    // callId is a QML-supplied correlation tag echoed back in phoneResult() so the
    // caller can match async replies to their request.  arguments may be empty {}.
    Q_INVOKABLE void phoneMcp(const QString &callId,
                              const QString &name,
                              const QVariantMap &arguments);

    // ---- Phone (Contract A phone.http proxy) --------------------------------
    // Forward a plain REST call to the phone server through the daemon's phone.http
    // method.  callId echoed back in phoneHttpResult(); body may be empty {}.
    // Result shape: {status:int, data:<obj|array>, text?}.
    Q_INVOKABLE void phoneHttp(const QString &callId,
                               const QString &method,
                               const QString &path,
                               const QVariantMap &body);

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

    // Canvas management (writes the append-only bus the desktop + engine share).
    // canvasDelete appends {op:"remove",id}; canvasClear appends {op:"clear"}.
    Q_INVOKABLE void canvasDelete(const QString &id);
    // Home dashboard widget ordering (user drag/move + the model's home_move).
    Q_INVOKABLE void saveHomeOrder(const QStringList &ids);
    Q_INVOKABLE QStringList homeOrder() const;
    Q_INVOKABLE void canvasClear();

    // Saved-widget library (saved_widgets.json). refreshSavedWidgets re-reads it
    // and emits savedWidgetsListed; saveWidget persists a spec under a name (tap
    // "Save as widget" on a canvas); deleteSavedWidget removes one; renderSavedWidget
    // drops a saved spec onto the bus (target: canvas|chat|voice|both).
    // Re-emit the widgets a (reopened) session rendered, so its chat/canvas
    // restore instead of coming back empty.
    Q_INVOKABLE void replaySessionWidgets(const QString &sessionId);
    // Re-emit ALL current canvases (the Canvas/Widgets tab tails from EOF, so a
    // widget rendered before the page opened wouldn't show otherwise). Called when
    // the Canvas/Widgets page becomes visible.
    Q_INVOKABLE void replayAllWidgets();

    // ---- Live-widget viewer leases (battery) ------------------------------
    // Tell the daemon which live-widget scope is currently on screen so an
    // unwatched live widget can idle. The daemon records a lease (refreshed by a
    // ~15s heartbeat) and the engine's supervisor only runs widgets a viewer holds.
    //   setPageViewing("<session_id>"|"all"|"", kind) — the single visible page's
    //     lease (a chat session, the Canvas tab = "all", or "" for none); replaces
    //     the previous page lease.
    //   addWidgetViewer/removeWidgetViewer — a popped-out widget window (concurrent
    //     with the page lease), scope "widget:<id>", kind "popout".
    Q_INVOKABLE void setPageViewing(const QString &scope,
                                    const QString &kind = QStringLiteral("chat"));
    Q_INVOKABLE void addWidgetViewer(const QString &scope,
                                     const QString &kind = QStringLiteral("popout"));
    Q_INVOKABLE void removeWidgetViewer(const QString &scope);

    Q_INVOKABLE void refreshSavedWidgets();
    Q_INVOKABLE void saveWidget(const QString &name, const QVariant &spec);
    Q_INVOKABLE void deleteSavedWidget(const QString &id);
    Q_INVOKABLE void renderSavedWidget(const QString &id, const QString &target);

signals:
    void connectedChanged();
    void sessionIdChanged();
    void statusChanged();
    void agentModeChanged();

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
    // Named voice library: a candidate reference clip was captured/loaded (ready
    // to name + save); the library changed (rows + current default voiceId); and
    // the result of a create/delete/set-default/rename action.
    void voiceClipCaptured(int bytes, const QString &format);
    void voiceLibraryChanged(const QVariantList &voices, const QString &defaultVoice);
    void voiceCloneResult(bool ok, const QString &error);
    void voiceCloneStateChanged();

    // ---- Contract A v2 results ---------------------------------------------
    void settingsLoaded(const QVariantMap &settings);
    void settingsSaved();
    // update.check / update.apply results for the Settings "Updates" section.
    void updateChecked(const QString &current, const QString &latest,
                       bool behind, const QString &version, const QString &reason);
    void updateApplied(bool updated, const QString &to, const QString &reason);
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
    // Fired when the app is brought up via launch/toggle-to-visible: the chat should
    // reset to a fresh NEW chat (so "open Jarvis" never lands in an old/Chrome session).
    void newChatRequested();
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
    // A PIN unlock attempt was rejected (wrong PIN) — the LockGate shakes/clears.
    void pinRejected();

    // ---- Memory results (Contract A v3) ------------------------------------
    // memory.list / memory.search both resolve here. `isSearch` lets the UI tell
    // a scored search result from a full list. Rows: {id,text,tags,created,score?}.
    void memoriesListed(const QVariantList &memories, bool isSearch);
    // Emitted after add/remove so the page can re-query.
    void memoryChanged();
    // memory.graph result: {nodes:[{id,kind,...}], edges:[{from,to,relation}]}.
    void memoryGraphLoaded(const QVariantMap &graph);
    // memory.entities.list result. Rows: {id,kind:"entity",name,type,scope,...}.
    void memoryEntitiesListed(const QVariantList &entities);
    // memory.entity.get result: the entity plus a `related` array (1-hop neighbors).
    void memoryEntityLoaded(const QVariantMap &entity);

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

    // ---- Agents results (custom subagents) ---------------------------------
    // Rows: {name,description,when_to_use,brain,model,profile,tools,color,path}.
    void agentsListed(const QVariantList &agents);
    // agents.get result.
    void agentLoaded(const QString &name, const QVariantMap &frontmatter,
                     const QString &systemPrompt, const QString &path);
    // Emitted after create/remove so the page can re-query.
    void agentsChanged();
    // agents.dispatch result — the spawned child session id + agent name.
    void agentDispatched(const QString &sessionId, const QString &agent);

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
    void voiceLevelChanged();
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

    // ---- Phone results ------------------------------------------------------
    // Emitted when a phone.mcp reply arrives; callId matches what was passed to
    // phoneMcp().  result contains the parsed tool response
    // {tool, data, text, error?} or {error: {...}} on failure.
    void phoneResult(const QString &callId, const QVariantMap &result);

    // Emitted when a phone.http reply arrives; callId matches what was passed to
    // phoneHttp().  result shape: {status:int, data:<obj|array>, text?} or
    // {error: {...}} on failure.
    void phoneHttpResult(const QString &callId, const QVariantMap &result);

    // ---- Notifications ------------------------------------------------------
    void notificationsChanged();

    // ---- System stats -------------------------------------------------------
    void statsChanged();

    void hasAgentDesktopChanged();

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

    // A canvas was deleted (op:"remove") or all were cleared (op:"clear") on the
    // bus — the CANVAS page + inline chat drop the matching card(s).
    void widgetRemoved(const QString &id);
    void widgetsCleared();

    // The saved-widget library (saved_widgets.json) was (re)loaded — `widgets` is
    // a list of {id, name, spec, created, updated} for the WIDGETS tab.
    void savedWidgetsListed(const QVariantList &widgets);

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
    // Append one record (widget or {op:...}) to the widgets bus file.
    void appendWidgetBusRecord(const QJsonObject &record);
    void send(const QString &method, const QVariantMap &params, int id);
    int request(const QString &method, const QVariantMap &params,
                const QString &ctx = QString());
    void setStatus(const QString &s);
    void handleResponse(int id, bool ok, const QVariantMap &result, const QVariantMap &error);

    // Session manager (Contract A): tell the daemon EXACTLY which session ids this
    // desktop is currently viewing (current chat + coworker + voice) so it fans only
    // those sessions' events to us. A foreign Chrome/phone session therefore never
    // reaches this client at all. Called on connect and whenever any of those ids
    // change; on a fresh, sessionless chat the set is empty (we receive nothing).
    // Older daemons answer unknown_method, which is swallowed (we then rely on the
    // existing client-side session filter as before).
    void syncSubscriptions();

    // COMPUTER page helpers.
    void setDriving(bool d);
    void setMirroring(bool m);
    void setHasAgentDesktop(bool v);
    // Query agent_desktop.info for the current session and update hasAgentDesktop
    // + the video endpoint. Called whenever the session changes.
    void refreshAgentDesktop();
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
    QString homeOrderPath() const;

    // Driving-demo fake pointer: advance the looping path one step and emit it.
    void tickDrivingDemo();

    // ---- Voice helpers ------------------------------------------------------
    void setRecordingState(const QString &s);
    void finishDictation();          // record stopped -> read wav -> voice.stt
    QString recordWavPath() const;   // temp wav path for the active capture
    void setVoiceCloneState(const QString &s);
    void finishCloneRecording();     // clone record stopped -> keep wav bytes
    static bool hasExecutable(const QString &name);

    // ---- Voice MODE helpers -------------------------------------------------
    void setVoiceState(const QString &s);
    // Wrap raw int16 mono PCM (m_voicePcm) in a 44-byte WAV header.
    QByteArray pcmToWav(const QByteArray &pcm, int sampleRate, int channels) const;
    // Decode TTS audio_b64 -> temp file -> play via QMediaPlayer (sets speaking).
    // playTtsAudio ENQUEUES the clip; playNextTtsClip stages+plays the head of the
    // queue. One assistant turn can arrive as several `message` events (each its own
    // voice.tts), so we play them strictly in order — one utterance finishes before
    // the next begins — instead of each new clip cutting off the one mid-sentence.
    void playTtsAudio(const QByteArray &audio, const QString &mime);
    void playNextTtsClip();
    void ensureTtsPlayer();
    // Serialize voice.tts REQUESTS: only one is in flight at a time, so the audio
    // is appended to m_ttsQueue in strict request order even if the daemon ever
    // returned them out of order. pumpTtsRequests sends the next queued request.
    void pumpTtsRequests();

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
    // True between our OWN session.create request and its reply, so the daemon's
    // session.opened broadcast (which arrives BEFORE the reply) isn't mistaken for a
    // foreign session and doesn't hijack/navigate the active chat.
    bool m_creatingSession = false;

    // ---- COMPUTER page state ------------------------------------------------
    QString m_coworkerSessionId;
    bool m_driving = false;
    bool m_mirroring = false;
    bool m_hasAgentDesktop = false;
    int m_frameSeq = 0;

    // Live-video poller (per-session computer-use engine GET /video/frame).
    FrameProvider *m_frameProvider = nullptr;
    QNetworkAccessManager *m_net = nullptr;
    QNetworkReply *m_frameReply = nullptr;
    QTimer *m_frameTimer = nullptr;
    QString m_videoBase;     // engine base url, e.g. http://127.0.0.1:8810
    QString m_videoBearer;   // cached computer-use bearer (from config.yaml)

    // ---- System stats (real, polled) ---------------------------------------
    void pollStats();           // read /proc, kick the async GPU probe
    void probeGpu();            // nvidia-smi (async, best-effort, one-shot probe)
    QTimer *m_statsTimer = nullptr;
    qreal m_cpuPercent = 0.0;
    qreal m_ramPercent = 0.0;
    qreal m_ramUsedGb = 0.0;
    qreal m_ramTotalGb = 0.0;
    qreal m_netUpMbps = 0.0;
    qreal m_netDownMbps = 0.0;
    bool m_gpuPresent = false;
    bool m_gpuProbed = false;   // stop probing after the first nvidia-smi miss
    qreal m_gpuPercent = 0.0;
    QString m_gpuName;
    qreal m_gpuMemUsedMb = 0.0;
    qreal m_gpuMemTotalMb = 0.0;
    // Previous /proc samples for delta math (cpu jiffies, net bytes, timestamp).
    quint64 m_cpuPrevTotal = 0;
    quint64 m_cpuPrevIdle = 0;
    quint64 m_netPrevRx = 0;
    quint64 m_netPrevTx = 0;
    qint64 m_statsPrevMs = 0;

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

    // Live-widget viewer leases: the scopes this desktop is currently watching
    // (scope -> kind) and a heartbeat that re-asserts them so they don't TTL out.
    // m_pageScope is the single visible page's lease (swapped on navigation);
    // popped-out widget windows add their own "widget:<id>" entries.
    QHash<QString, QString> m_widgetViewers;
    QString m_pageScope;
    QTimer *m_viewerHeartbeat = nullptr;
    void sendWidgetViewing(const QString &scope, bool active, const QString &kind);

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
    // Named voice-library reference-clip recorder (separate from dictation above).
    QString m_voiceCloneState = QStringLiteral("idle");
    QProcess *m_cloneRecProc = nullptr; // active pw-record capture for a voice clip
    QString m_cloneRecPath;             // temp wav path for the clip capture
    bool m_cloneAutoStop = false;       // duration timer will stop the clip capture
    QByteArray m_voiceClipBytes;        // the captured/loaded candidate reference clip
    QString m_voiceClipFormat;          // its container ext ("wav", "mp3", ...)
    QString m_voiceClipSource = QStringLiteral("upload"); // "record" | "upload"
    // Hands-free voice mode capture: continuous pw-record streaming raw s16 to
    // stdout (same proven path as dictation). m_pwHeaderSkip drops the WAV header.
    QProcess *m_voiceProc = nullptr;
    int m_pwHeaderSkip = 0;
    bool m_ttsRequested = false;        // a voice.tts is in flight (route the reply)

    // ---- Voice MODE (QtMultimedia capture + playback, orb state) ------------
    QString m_voiceState = QStringLiteral("idle");
    QString m_agentMode = QStringLiteral("coworker"); // plan|build|coworker (settings.get)
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
    QByteArray m_ttsDeviceId;   // chosen TTS output sink id (empty = system default)
    QString m_ttsTmpPath;              // last decoded TTS file (kept until next play)
    // FIFO of TTS clips waiting to play. A turn that arrives as multiple message
    // events queues here so each utterance plays to completion before the next —
    // the single shared player used to interrupt itself, cutting sentences off.
    struct TtsClip { QByteArray audio; QString mime; };
    QList<TtsClip> m_ttsQueue;
    // Pending TTS REQUESTS (text not yet sent), drained one at a time so the
    // generated audio is appended to m_ttsQueue in strict order. `voiceMode`
    // tags the voice-mode path (drives orb + hands-free resume).
    struct TtsReq { QString text; bool voiceMode; };
    QList<TtsReq> m_ttsReqQueue;
    bool m_ttsReqInFlight = false;     // a voice.tts request is awaiting its reply
    bool m_ttsPlaying = false;         // a clip is currently on the player
    int m_ttsTmpSeq = 0;               // ping-pong temp-file index (avoid rewriting in-use path)
    // The dedicated voice session id (coworker/coder), so "what's on my screen"
    // works. Mirrors m_sessionId once created; we (re)use createSession.
    QString m_voiceSessionId;
    QString m_voiceBrain;   // preferred brain for the voice session (codex/claude)
    QString m_voiceModel;   // preferred model for the voice session
    // True while a voice-mode STT turn is in flight, so the transcript reply is
    // auto-sent to the session (distinct from the chat-page dictation path).
    bool m_voiceModeStt = false;

    // ---- Hands-free conversation (energy VAD over the capture buffer) -------
    bool m_handsFree = false;          // continuous-listen mode active
    bool m_vadSpeech = false;          // speech currently detected in this utterance
    bool m_vadPaused = false;          // capture parked while model thinks/speaks
    qint64 m_vadSilenceBytes = 0;      // trailing silence accumulated since last speech
    qint64 m_vadSpeechBytes = 0;       // voiced bytes in the current utterance
    qreal m_voiceLevel = 0.0;          // last mic input level (0..1) for UI feedback
    QTimer *m_vadWatchdog = nullptr;   // resume-listening fallback if no TTS arrives
    void handsFreeFeed(const QByteArray &chunk);  // VAD step on a capture chunk
    void resumeListening();            // clear buffers + go back to listening

    // ---- Notifications ------------------------------------------------------
    bool m_notify = true;               // mirror of settings.notifications.enabled
};
