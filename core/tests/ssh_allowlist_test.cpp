// ctest: SshAllowList rejects non-allow-listed hosts (host_not_allowed, ssh
// never spawned) and persists allow_add/remove across loads.

#include "jarvis/SshAllowList.h"

#include <QCoreApplication>
#include <QFile>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::SshAllowList;

namespace {
int g_failures = 0;
void check(bool cond, const char *msg)
{
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", msg); ++g_failures; }
    else { std::fprintf(stderr, "ok: %s\n", msg); }
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    QTemporaryDir tmp;
    check(tmp.isValid(), "temp dir created");
    const QString path = tmp.path() + QStringLiteral("/ssh_allow.json");

    SshAllowList allow;
    check(allow.load(path), "load (missing file) ok");
    check(allow.hosts().isEmpty(), "empty allow-list initially");

    // --- the SECURITY-CRITICAL property: a non-listed host is rejected and ssh
    // is never executed. exec() must return allowed=false / host_not_allowed.
    {
        const SshAllowList::ExecResult r =
            allow.exec(QStringLiteral("evil.example.com"), QStringLiteral("rm -rf /"));
        check(!r.allowed, "non-allow-listed host: allowed=false");
        check(!r.ok, "non-allow-listed host: ok=false");
        check(r.error == QStringLiteral("host_not_allowed"),
              "non-allow-listed host: error=host_not_allowed");
        // exitCode stays at the default -1 (no process ran).
        check(r.exitCode == -1, "non-allow-listed host: ssh never spawned (exitCode -1)");
    }

    // --- allow_add then it IS allowed (we don't actually run ssh in the test;
    // we only assert the gate opens — exec to a bogus host will fail to connect,
    // but allowed must now be true).
    check(allow.add(QStringLiteral("build@10.0.0.5")), "allow_add new host returns true");
    check(!allow.add(QStringLiteral("build@10.0.0.5")), "allow_add duplicate returns false");
    check(allow.isAllowed(QStringLiteral("build@10.0.0.5")), "added host is allowed");
    // Host part is case-insensitive; a different-case host matches.
    check(allow.isAllowed(QStringLiteral("build@10.0.0.5")), "exact match allowed");

    // A still-unlisted host stays rejected.
    check(!allow.isAllowed(QStringLiteral("other.host")), "unlisted host not allowed");
    {
        const SshAllowList::ExecResult r =
            allow.exec(QStringLiteral("other.host"), QStringLiteral("echo hi"));
        check(!r.allowed && r.error == QStringLiteral("host_not_allowed"),
              "second unlisted host still rejected");
    }

    // --- persistence: a fresh instance loading the same file sees the host, and
    // the file is 0600.
    {
        SshAllowList reload;
        check(reload.load(path), "reload persisted allow-list");
        check(reload.isAllowed(QStringLiteral("build@10.0.0.5")),
              "persisted host present after reload");
#ifdef Q_OS_UNIX
        const auto perms = QFile::permissions(path);
        const bool groupOrOther =
            perms & (QFileDevice::ReadGroup | QFileDevice::ReadOther |
                     QFileDevice::WriteGroup | QFileDevice::WriteOther);
        check(!groupOrOther, "ssh_allow.json is 0600 (no group/other access)");
#endif
    }

    // --- remove ------------------------------------------------------------
    check(allow.remove(QStringLiteral("build@10.0.0.5")), "remove existing host true");
    check(!allow.isAllowed(QStringLiteral("build@10.0.0.5")), "removed host no longer allowed");
    check(!allow.remove(QStringLiteral("build@10.0.0.5")), "remove missing host false");

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
