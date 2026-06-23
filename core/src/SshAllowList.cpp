#include "jarvis/SshAllowList.h"

#include "jarvis/Config.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcess>

namespace jarvis {

QString SshAllowList::defaultPath()
{
    return Config::configDir() + QStringLiteral("/ssh_allow.json");
}

QString SshAllowList::normalize(const QString &host)
{
    // Trim, and lower-case the host part. Keep an optional "user@" prefix as-is
    // (usernames are case-sensitive) but lower-case the host after '@'.
    QString h = host.trimmed();
    const int at = h.indexOf(QLatin1Char('@'));
    if (at >= 0) {
        const QString user = h.left(at);
        const QString rest = h.mid(at + 1).toLower();
        return user + QLatin1Char('@') + rest;
    }
    return h.toLower();
}

bool SshAllowList::load(const QString &path)
{
    m_path = path.isEmpty() ? defaultPath() : path;
    m_hosts.clear();

    QFile f(m_path);
    if (!f.exists())
        return true; // empty allow-list is valid
    if (!f.open(QIODevice::ReadOnly)) {
        m_lastError = QStringLiteral("cannot read ssh allow-list: ") + f.errorString();
        return false;
    }
    const QByteArray bytes = f.readAll();
    f.close();

    QJsonParseError perr{};
    const QJsonDocument doc = QJsonDocument::fromJson(bytes, &perr);
    if (perr.error != QJsonParseError::NoError) {
        m_lastError = QStringLiteral("malformed ssh_allow.json: ") + perr.errorString();
        return false;
    }
    // Accept either {"hosts":[...]} or a bare [...] array.
    QJsonArray arr;
    if (doc.isObject())
        arr = doc.object().value(QStringLiteral("hosts")).toArray();
    else if (doc.isArray())
        arr = doc.array();
    for (const QJsonValue &v : arr) {
        const QString h = normalize(v.toString());
        if (!h.isEmpty() && !m_hosts.contains(h))
            m_hosts << h;
    }
    return true;
}

bool SshAllowList::save() const
{
    const QString path = m_path.isEmpty() ? defaultPath() : m_path;
    const QFileInfo fi(path);
    QDir().mkpath(fi.absolutePath());

    QJsonArray arr;
    for (const QString &h : m_hosts)
        arr.append(h);
    QJsonObject root;
    root.insert(QStringLiteral("hosts"), arr);

    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_lastError = QStringLiteral("cannot write ssh allow-list: ") + f.errorString();
        return false;
    }
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    f.close();
    // Allow-list of remote hosts is sensitive -> 0600.
    QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    return true;
}

bool SshAllowList::isAllowed(const QString &host) const
{
    return m_hosts.contains(normalize(host));
}

bool SshAllowList::add(const QString &host)
{
    const QString h = normalize(host);
    if (h.isEmpty() || m_hosts.contains(h))
        return false;
    m_hosts << h;
    save();
    return true;
}

bool SshAllowList::remove(const QString &host)
{
    const QString h = normalize(host);
    if (!m_hosts.removeOne(h))
        return false;
    save();
    return true;
}

SshAllowList::ExecResult SshAllowList::exec(const QString &host, const QString &cmd,
                                            int timeoutMs) const
{
    ExecResult res;

    // HARD GATE: never spawn ssh for a non-allow-listed host.
    if (!isAllowed(host)) {
        res.allowed = false;
        res.ok = false;
        res.error = QStringLiteral("host_not_allowed");
        return res;
    }
    if (cmd.trimmed().isEmpty()) {
        res.error = QStringLiteral("empty command");
        return res;
    }

    QProcess proc;
    // BatchMode=yes => fail instead of prompting for a password (no blocking);
    // StrictHostKeyChecking=accept-new => first connect doesn't hang on a prompt
    // either, while still pinning the key thereafter.
    QStringList args;
    args << QStringLiteral("-o") << QStringLiteral("BatchMode=yes")
         << QStringLiteral("-o") << QStringLiteral("StrictHostKeyChecking=accept-new")
         << QStringLiteral("-o") << QStringLiteral("ConnectTimeout=10")
         << normalize(host) << cmd;

    proc.setProcessChannelMode(QProcess::MergedChannels);
    proc.start(QStringLiteral("ssh"), args);
    if (!proc.waitForStarted(5000)) {
        res.error = QStringLiteral("failed to start ssh: ") + proc.errorString();
        return res;
    }
    if (!proc.waitForFinished(timeoutMs)) {
        proc.kill();
        proc.waitForFinished(2000);
        res.error = QStringLiteral("ssh timed out after ") +
                    QString::number(timeoutMs) + QStringLiteral("ms");
        res.output = QString::fromUtf8(proc.readAll());
        return res;
    }

    res.exitCode = proc.exitCode();
    res.output = QString::fromUtf8(proc.readAll());
    // Cap output so a runaway command can't flood the wire.
    constexpr int kMaxOut = 64 * 1024;
    if (res.output.size() > kMaxOut)
        res.output = res.output.left(kMaxOut) +
                     QStringLiteral("\n…(truncated)");
    res.ok = (proc.exitStatus() == QProcess::NormalExit && res.exitCode == 0);
    if (!res.ok && res.error.isEmpty())
        res.error = QStringLiteral("ssh exited with code ") + QString::number(res.exitCode);
    return res;
}

QJsonObject SshAllowList::toJson() const
{
    QJsonArray arr;
    for (const QString &h : m_hosts)
        arr.append(h);
    QJsonObject o;
    o.insert(QStringLiteral("hosts"), arr);
    return o;
}

} // namespace jarvis
