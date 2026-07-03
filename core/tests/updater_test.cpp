// Unit test for Updater PURE LOGIC: parsing the platform self-update script's
// `check` JSON ({current, latest, behind}) and the version/SHA compare (behind
// vs up-to-date). No QProcess, no network — only the static parse/compare funcs.

#include "jarvis/Updater.h"

#include <QByteArray>

#include <cstdio>

using jarvis::Updater;
using jarvis::UpdateStatus;

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
    // --- computeBehind: the core compare ----------------------------------
    {
        // Script flag wins outright.
        check(Updater::computeBehind(QStringLiteral("aaaa"), QStringLiteral("aaaa"), true),
              "computeBehind: script behind=true overrides equal ids");
        // Two non-empty differing ids => behind.
        check(Updater::computeBehind(QStringLiteral("aaaa"), QStringLiteral("bbbb"), false),
              "computeBehind: current != latest => behind");
        // Equal ids, no script flag => up to date.
        check(!Updater::computeBehind(QStringLiteral("aaaa"), QStringLiteral("aaaa"), false),
              "computeBehind: current == latest => up to date");
        // A missing side can't be judged => not behind.
        check(!Updater::computeBehind(QString(), QStringLiteral("bbbb"), false),
              "computeBehind: empty current => up to date (can't tell)");
        check(!Updater::computeBehind(QStringLiteral("aaaa"), QString(), false),
              "computeBehind: empty latest => up to date (can't tell)");
    }

    // --- parseCheckResult: Linux check (behind=true) ----------------------
    {
        const QByteArray json =
            R"({"current":"196e4f3abcd1","latest":"5d316b0ffff2","behind":true,"branch":"main"})";
        const UpdateStatus st = Updater::parseCheckResult(
            json, QStringLiteral("0.12.0"), QStringLiteral("196e4f3"));
        check(st.ok, "parse: valid JSON => ok");
        check(st.behind, "parse: behind=true honored");
        check(st.current == QStringLiteral("196e4f3abcd1"), "parse: current read");
        check(st.latest == QStringLiteral("5d316b0ffff2"), "parse: latest read");
        check(st.version == QStringLiteral("0.12.0"), "parse: running version carried");
    }

    // --- parseCheckResult: up to date (behind=false, equal) ---------------
    {
        const QByteArray json =
            R"({"current":"5d316b0ffff2","latest":"5d316b0ffff2","behind":false,"branch":"main"})";
        const UpdateStatus st = Updater::parseCheckResult(json);
        check(st.ok, "parse(up-to-date): ok");
        check(!st.behind, "parse(up-to-date): not behind");
    }

    // --- parseCheckResult: script says behind=false but ids differ --------
    // The fallback compare promotes a current!=latest mismatch to behind.
    {
        const QByteArray json =
            R"({"current":"aaaa1111","latest":"bbbb2222","behind":false})";
        const UpdateStatus st = Updater::parseCheckResult(json);
        check(st.behind, "parse: differing ids => behind even when script behind=false");
    }

    // --- parseCheckResult: non-git install (null current/latest) ----------
    {
        const QByteArray json =
            R"({"current":null,"latest":null,"behind":false,"reason":"not a git checkout"})";
        const UpdateStatus st = Updater::parseCheckResult(
            json, QStringLiteral("0.12.0"), QStringLiteral("196e4f3"));
        check(st.ok, "parse(non-git): ok");
        check(!st.behind, "parse(non-git): not behind (null ids)");
        check(st.current == QStringLiteral("196e4f3"),
              "parse(non-git): empty current falls back to runningSha");
        check(st.reason == QStringLiteral("not a git checkout"),
              "parse(non-git): reason carried through");
    }

    // --- parseCheckResult: Windows version tags ---------------------------
    {
        const QByteArray json =
            R"({"current":"0.11.0","latest":"0.12.0","behind":true})";
        const UpdateStatus st = Updater::parseCheckResult(json, QStringLiteral("0.11.0"));
        check(st.ok && st.behind, "parse(windows tags): behind=true honored");
        check(st.latest == QStringLiteral("0.12.0"), "parse(windows tags): latest tag read");
    }

    // --- parseCheckResult: garbage / empty output => not ok ---------------
    {
        const UpdateStatus st = Updater::parseCheckResult(
            QByteArray("not json at all"), QStringLiteral("0.12.0"), QStringLiteral("196e4f3"));
        check(!st.ok, "parse(garbage): ok=false");
        check(!st.behind, "parse(garbage): never reports behind");
        check(st.current == QStringLiteral("196e4f3"),
              "parse(garbage): current falls back to runningSha");
    }

    // --- runningVersion/runningSha: stamped, non-empty --------------------
    {
        check(!Updater::runningVersion().isEmpty(), "runningVersion is stamped (non-empty)");
        check(!Updater::runningSha().isEmpty(), "runningSha is stamped (non-empty)");
    }

    // --- native release flow helpers (jarvis: packaged self-update) ---------
    {
        using RA = jarvis::Updater::ReleaseAsset;
        const QByteArray rel = R"({
            "tag_name": "v0.13.2",
            "assets": [
                {"name": "Jarvis-0.13.2-x86_64.AppImage",
                 "browser_download_url": "https://x/app.AppImage"},
                {"name": "Jarvis-Setup-0.13.2.exe",
                 "browser_download_url": "https://x/setup.exe"}
            ]
        })";
        const RA exe = jarvis::Updater::parseLatestRelease(rel, "Jarvis-Setup-*.exe");
        check(exe.tag == QStringLiteral("0.13.2"), "release tag parsed, v stripped");
        check(exe.name == QStringLiteral("Jarvis-Setup-0.13.2.exe"), "exe asset picked");
        check(exe.url == QStringLiteral("https://x/setup.exe"), "exe url picked");
        const RA app = jarvis::Updater::parseLatestRelease(rel, "*.AppImage");
        check(app.name.endsWith(QStringLiteral(".AppImage")), "AppImage asset picked");
        const RA none = jarvis::Updater::parseLatestRelease(rel, "*.dmg");
        check(none.tag.isEmpty(), "no matching asset -> empty");
        check(jarvis::Updater::parseLatestRelease("not json", "*").tag.isEmpty(),
              "junk body -> empty");

        check(jarvis::Updater::versionGreater("0.13.2", "0.13.1"), "patch bump greater");
        check(jarvis::Updater::versionGreater("v0.14.0", "0.13.9"), "minor beats patch, v ok");
        check(!jarvis::Updater::versionGreater("0.13.2", "0.13.2"), "equal not greater");
        check(!jarvis::Updater::versionGreater("0.13.1", "0.13.2"), "older not greater");
        check(jarvis::Updater::versionGreater("1.0.0", "0.99.99"), "major wins");
        check(jarvis::Updater::versionGreater("0.13.2", "0.13.2-rc1"),
              "stable beats its own pre-release");
        check(!jarvis::Updater::versionGreater("0.13.2-rc1", "0.13.2"),
              "pre-release does not beat the stable");
        check(!jarvis::Updater::versionGreater("", "0.1.0"), "empty latest never greater");
        check(!jarvis::Updater::versionGreater("0.2.0", ""), "empty current never behind");
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS updater_test\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL updater_test (%d failures)\n", g_failures);
    return 1;
}
