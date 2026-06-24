// Unit test for AuthChallengeStore (2FA + fingerprint cross-device unlock core).
// Pure logic, no sockets: drives the full challenge lifecycle.

#include "jarvis/AuthChallengeStore.h"

#include <sodium.h>

#include <QCoreApplication>
#include <QThread>

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
    if (sodium_init() < 0) {
        std::fprintf(stderr, "FAIL: libsodium init failed\n");
        return 1;
    }

    jarvis::AuthChallengeStore store;

    // --- create -> pending -------------------------------------------------
    const jarvis::AuthChallenge c = store.create();
    check(!c.id.isEmpty(), "create returns a challenge id");
    check(c.id.size() == 24, "challenge id is 24 hex chars");
    bool allHex = true;
    for (QChar ch : c.id)
        if (!((ch >= QLatin1Char('0') && ch <= QLatin1Char('9')) ||
              (ch >= QLatin1Char('a') && ch <= QLatin1Char('f'))))
            allHex = false;
    check(allHex, "challenge id is lowercase hex");
    check(c.state == QStringLiteral("pending"), "fresh challenge is pending");
    check(c.origin == QStringLiteral("desktop"), "default origin is desktop");
    check(c.expiresAt > c.createdAt, "challenge has a future expiry");

    // origin tag round-trips.
    const jarvis::AuthChallenge ext =
        store.create(jarvis::AuthChallengeStore::kDefaultTtlMs,
                     QStringLiteral("extension"));
    check(ext.origin == QStringLiteral("extension"), "origin tag is honored");
    check(ext.id != c.id, "distinct challenges get distinct ids");

    // --- approve -> approved + single-use ----------------------------------
    check(store.approve(c.id, QStringLiteral("dev1")),
          "approve a pending challenge returns true");
    {
        const auto got = store.get(c.id);
        check(got.has_value(), "get returns the approved challenge");
        check(got && got->state == QStringLiteral("approved"),
              "approved challenge reads back as approved");
        check(got && got->approvedByDevice == QStringLiteral("dev1"),
              "approvedByDevice records the device id");
    }
    check(!store.approve(c.id, QStringLiteral("dev2")),
          "approving an already-approved challenge returns false");

    // statusJson reflects the approved state.
    {
        const QJsonObject st = store.statusJson(c.id);
        check(st.value(QStringLiteral("state")).toString() ==
                  QStringLiteral("approved"),
              "statusJson reports approved");
        check(st.value(QStringLiteral("challenge_id")).toString() == c.id,
              "statusJson echoes the challenge id");
    }

    // --- expiry: ttl in the past -> expired, approve fails -----------------
    const jarvis::AuthChallenge shortC = store.create(/*ttlMs=*/1);
    QThread::msleep(5); // > ttl
    {
        const auto got = store.get(shortC.id);
        check(got.has_value(), "get still returns an expired challenge");
        check(got && got->state == QStringLiteral("expired"),
              "prune-on-read flips an expired pending challenge to expired");
    }
    check(!store.approve(shortC.id, QStringLiteral("devx")),
          "cannot approve an expired challenge");

    // --- deny: pending -> denied -------------------------------------------
    const jarvis::AuthChallenge d = store.create();
    check(store.deny(d.id), "deny a pending challenge returns true");
    {
        const auto got = store.get(d.id);
        check(got && got->state == QStringLiteral("denied"),
              "denied challenge reads back as denied");
    }
    check(!store.approve(d.id, QStringLiteral("dev1")),
          "cannot approve a denied challenge");
    check(!store.deny(d.id), "cannot deny an already-denied challenge");

    // --- unknown id reports "expired" (no existence leak) ------------------
    {
        const QJsonObject st = store.statusJson(QStringLiteral("deadbeefdeadbeefdeadbeef"));
        check(st.value(QStringLiteral("state")).toString() ==
                  QStringLiteral("expired"),
              "statusJson(unknown id) reports expired");
    }
    check(!store.get(QStringLiteral("nope")).has_value(),
          "get(unknown id) returns nullopt");
    check(!store.approve(QStringLiteral("nope"), QStringLiteral("dev1")),
          "approve(unknown id) returns false");

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS auth_challenge_test\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL auth_challenge_test (%d failures)\n", g_failures);
    return 1;
}
