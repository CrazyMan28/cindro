// Unit test for WidgetLeaseRegistry — the daemon's viewer-lease store that gates
// live-widget work (battery). Uses an isolated tmp dir so it never touches the
// user's real ~/.local/share/jarvis/widget_viewers. Pure file-store proof.

#include "jarvis/WidgetLeaseRegistry.h"

#include <QDir>
#include <QTemporaryDir>

#include <cstdio>

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

int main()
{
    QTemporaryDir tmp;
    const QString dir = tmp.path() + QStringLiteral("/viewers");
    const qint64 T0 = 1000000;  // fixed clock (ms)

    // touch -> the scope is active.
    {
        jarvis::WidgetLeaseRegistry reg(dir);
        reg.touch(QStringLiteral("s1"), QStringLiteral("chat"), QStringLiteral("desktop"), T0);
        check(reg.activeScopes(45000, T0 + 1000).contains(QStringLiteral("s1")),
              "a fresh lease is active");
    }

    // TTL: a lease older than 45s is no longer active and gets swept.
    {
        jarvis::WidgetLeaseRegistry reg(dir);
        reg.touch(QStringLiteral("s2"), QStringLiteral("chat"), QStringLiteral("desktop"), T0);
        check(!reg.activeScopes(45000, T0 + 60000).contains(QStringLiteral("s2")),
              "a 60s-old lease is NOT active (TTL 45s)");
        const int swept = reg.sweep(45000, T0 + 60000);
        check(swept >= 1, "sweep removes the stale lease");
    }

    // clear(scope, source) removes just that lease.
    {
        jarvis::WidgetLeaseRegistry reg(dir);
        reg.touch(QStringLiteral("all"), QStringLiteral("canvas"), QStringLiteral("desktop"), T0);
        reg.touch(QStringLiteral("widget:w9"), QStringLiteral("popout"), QStringLiteral("desktop"), T0);
        reg.clear(QStringLiteral("all"), QStringLiteral("desktop"));
        const QStringList active = reg.activeScopes(45000, T0 + 1000);
        check(!active.contains(QStringLiteral("all")), "clear() drops the named lease");
        check(active.contains(QStringLiteral("widget:w9")), "clear() leaves the other lease");
    }

    // clearSource removes every lease a client held (used on disconnect).
    {
        jarvis::WidgetLeaseRegistry reg(dir);
        reg.touch(QStringLiteral("sA"), QStringLiteral("chat"), QStringLiteral("phone-123"), T0);
        reg.touch(QStringLiteral("widget:p"), QStringLiteral("pin"), QStringLiteral("phone-123"), T0);
        reg.touch(QStringLiteral("sB"), QStringLiteral("chat"), QStringLiteral("desktop"), T0);
        reg.clearSource(QStringLiteral("phone-123"));
        const QStringList active = reg.activeScopes(45000, T0 + 1000);
        check(!active.contains(QStringLiteral("sA")) && !active.contains(QStringLiteral("widget:p")),
              "clearSource drops all of that source's leases");
        check(active.contains(QStringLiteral("sB")), "clearSource leaves other sources");
    }

    // wipeAll clears everything (daemon startup, no phantom 'all' lease survives a crash).
    {
        jarvis::WidgetLeaseRegistry reg(dir);
        reg.touch(QStringLiteral("all"), QStringLiteral("canvas"), QStringLiteral("desktop"), T0);
        reg.wipeAll();
        check(reg.activeScopes(45000, T0 + 1000).isEmpty(), "wipeAll empties the registry");
    }

    // Two sources holding the same scope: dropping one keeps the scope active.
    {
        jarvis::WidgetLeaseRegistry reg(dir);
        reg.wipeAll();
        reg.touch(QStringLiteral("s1"), QStringLiteral("chat"), QStringLiteral("desktop"), T0);
        reg.touch(QStringLiteral("s1"), QStringLiteral("chat"), QStringLiteral("phone-9"), T0);
        reg.clear(QStringLiteral("s1"), QStringLiteral("desktop"));
        check(reg.activeScopes(45000, T0 + 1000).contains(QStringLiteral("s1")),
              "scope stays active while another source still holds it");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "ALL WidgetLeaseRegistry TESTS PASSED\n");
    return g_failures == 0 ? 0 : 1;
}
