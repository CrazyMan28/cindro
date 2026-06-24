// ctest: Google-connectors store-level proof. Open a temp-DB SessionStore +
// McpRegistry, add a connector row (stdio, disabled, env JSON), assert list()
// returns it as "google-calendar" with enabled==false, the env round-trips, and
// toJson() omits env + token. Mirrors memory_store_test.

#include "jarvis/Connectors.h"
#include "jarvis/McpRegistry.h"
#include "jarvis/SessionStore.h"

#include <QCoreApplication>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

namespace Connectors = jarvis::Connectors;
using jarvis::McpRegistry;
using jarvis::McpServerRow;
using jarvis::SessionStore;

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

    // --- catalog helpers (pure data) --------------------------------------
    check(Connectors::isKnownService(QStringLiteral("calendar")), "calendar is a known service");
    check(Connectors::isKnownService(QStringLiteral("docs")), "docs is a known service");
    check(Connectors::isKnownService(QStringLiteral("drive")), "drive is a known service");
    check(Connectors::isKnownService(QStringLiteral("gmail")), "gmail is a known service");
    check(!Connectors::isKnownService(QStringLiteral("nope")), "unknown service rejected");
    check(Connectors::serverName(QStringLiteral("calendar")) == QStringLiteral("google-calendar"),
          "serverName(calendar) == google-calendar");
    check(Connectors::serviceFromServerName(QStringLiteral("google-gmail")) == QStringLiteral("gmail"),
          "serviceFromServerName(google-gmail) == gmail");
    check(Connectors::serviceFromServerName(QStringLiteral("computer-use")).isEmpty(),
          "non-connector server name yields empty service");
    check(!Connectors::defaultCommandFor(QStringLiteral("calendar")).isEmpty(),
          "calendar has a default command");
    check(Connectors::secretKey(QStringLiteral("abc"), QStringLiteral("client_secret"))
              == QStringLiteral("connector:abc:client_secret"),
          "secretKey is namespaced");
    check(Connectors::secretRef(QStringLiteral("abc"), QStringLiteral("client_secret"))
              == QStringLiteral("secret:connector:abc:client_secret"),
          "secretRef is a secret: reference");

    QTemporaryDir tmp;
    check(tmp.isValid(), "temp dir created");
    const QString dbPath = tmp.path() + QStringLiteral("/connectors_test.db");

    SessionStore store;
    check(store.open(dbPath, QStringLiteral("connectors-test-conn")), "store open + migrate");

    McpRegistry mcp(store);

    // --- add a connector row (stdio, disabled, env JSON) -------------------
    const QString service = QStringLiteral("calendar");
    QJsonObject env;
    env.insert(QStringLiteral("GOOGLE_OAUTH_CLIENT_ID"),
               Connectors::secretRef(QStringLiteral("placeholder"), QStringLiteral("client_id")));
    env.insert(QStringLiteral("GOOGLE_OAUTH_CLIENT_SECRET"),
               Connectors::secretRef(QStringLiteral("placeholder"), QStringLiteral("client_secret")));
    env.insert(QStringLiteral("GOOGLE_OAUTH_REFRESH_TOKEN"),
               Connectors::secretRef(QStringLiteral("placeholder"), QStringLiteral("refresh_token")));

    const QString id = mcp.add(Connectors::serverName(service), QStringLiteral("stdio"),
                               Connectors::defaultCommandFor(service), QString(),
                               /*enabled=*/false, Connectors::riskFor(service), env);
    check(!id.isEmpty(), "connector row added with id");

    // --- list() returns it as a disabled stdio connector ------------------
    bool found = false;
    McpServerRow got;
    for (const McpServerRow &r : mcp.list()) {
        if (r.id == id) { found = true; got = r; break; }
    }
    check(found, "added connector appears in list()");
    check(got.name == QStringLiteral("google-calendar"), "name is google-calendar");
    check(got.transport == QStringLiteral("stdio"), "transport is stdio");
    check(got.enabled == false, "connector is DISABLED (mock requirement)");
    check(got.builtin == false, "connector is not builtin");

    // --- env round-trips through the row ----------------------------------
    check(got.env.value(QStringLiteral("GOOGLE_OAUTH_CLIENT_SECRET")).toString()
              == Connectors::secretRef(QStringLiteral("placeholder"), QStringLiteral("client_secret")),
          "env CLIENT_SECRET round-trips as a secret-ref");
    check(got.env.size() == 3, "env has all three OAuth keys");

    // get() also resolves it
    auto fetched = store.getMcpServer(id);
    check(fetched.has_value(), "getMcpServer returns the row");
    check(fetched && fetched->env.size() == 3, "getMcpServer env round-trips");

    // --- toJson() OMITS env + token ---------------------------------------
    const QJsonObject j = got.toJson();
    check(!j.contains(QStringLiteral("env")), "toJson omits env");
    check(!j.contains(QStringLiteral("token")), "toJson omits token");
    check(j.value(QStringLiteral("has_token")).toBool() == false, "has_token is false (no http token)");
    check(j.value(QStringLiteral("enabled")).toBool() == false, "toJson enabled==false");
    check(j.value(QStringLiteral("name")).toString() == QStringLiteral("google-calendar"),
          "toJson name is google-calendar");

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
