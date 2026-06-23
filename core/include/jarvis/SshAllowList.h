#pragma once

// SshAllowList — gated remote-command execution (BUILD_SPEC CONTRACT-A
// additions + ROLE: "SSH allow-list (core)").
//
//   ssh.allow_list  -> {hosts:[...]}
//   ssh.allow_add{host}
//   ssh.allow_remove{host}
//   ssh.exec{host,cmd} -> {ok,output}   ONLY if `host` is allow-listed,
//                                        else error 'host_not_allowed'.
//
// The allow-list persists to ~/.config/jarvis/ssh_allow.json (0600). ssh.exec
// runs `ssh -o BatchMode=yes <host> <cmd>` via QProcess (BatchMode so it never
// blocks on an interactive password prompt). ssh.exec is a BIOMETRIC-tier
// action over the device channel and is audited by the daemon.

#include <QJsonObject>
#include <QString>
#include <QStringList>

namespace jarvis {

class SshAllowList {
public:
    struct ExecResult {
        bool ok = false;     // process ran AND exited 0
        int exitCode = -1;
        QString output;      // merged stdout+stderr (truncated)
        QString error;       // populated when ok==false (e.g. timeout, not allowed)
        bool allowed = true; // false => host_not_allowed (never executed)
    };

    SshAllowList() = default;

    // Path to ~/.config/jarvis/ssh_allow.json.
    static QString defaultPath();

    // Load the allow-list from disk (defaultPath() unless overridden). A missing
    // file is fine (empty list). Returns false only on a malformed file.
    bool load(const QString &path = QString());

    // The current allow-listed hosts (normalized, de-duplicated).
    QStringList hosts() const { return m_hosts; }

    // True if `host` is in the allow-list (exact, case-insensitive on the host
    // part; a "user@host" entry matches the same "user@host" exactly).
    bool isAllowed(const QString &host) const;

    // Add/remove a host; persists immediately. add() is idempotent; returns true
    // if the list changed.
    bool add(const QString &host);
    bool remove(const QString &host);

    // Run `cmd` on `host` over ssh, but ONLY if the host is allow-listed.
    // Non-allowed hosts return {allowed:false, error:"host_not_allowed"} WITHOUT
    // ever spawning ssh. `timeoutMs` bounds the call (default 20s).
    ExecResult exec(const QString &host, const QString &cmd, int timeoutMs = 20000) const;

    // {hosts:[...]} for the ssh.allow_list response.
    QJsonObject toJson() const;

    QString lastError() const { return m_lastError; }

private:
    bool save() const;
    static QString normalize(const QString &host);

    QString m_path;
    QStringList m_hosts;
    mutable QString m_lastError;
};

} // namespace jarvis
